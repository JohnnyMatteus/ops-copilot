// Decorador do LlmClient: um span por chamada (convenções gen_ai do OpenTelemetry) e métricas
// de tokens e custo. Os nós do grafo não sabem que a telemetria existe.
import type { Tracer } from '@opentelemetry/api';
import type { ChatRequest, ChatResponse, LlmClient } from '../llm/client.js';
import type { CopilotMetrics } from './metrics.js';
import { withSpan } from './tracing.js';

export class InstrumentedLlmClient implements LlmClient {
  readonly #inner: LlmClient;
  readonly #tracer: Tracer;
  readonly #metrics: CopilotMetrics;

  constructor(inner: LlmClient, tracer: Tracer, metrics: CopilotMetrics) {
    this.#inner = inner;
    this.#tracer = tracer;
    this.#metrics = metrics;
  }

  chat(request: ChatRequest): Promise<ChatResponse> {
    return withSpan(
      this.#tracer,
      'gen_ai.chat',
      { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': request.model, 'gen_ai.request.temperature': request.temperature },
      async (set) => {
        const response = await this.#inner.chat(request);
        set({
          'gen_ai.response.model': response.model,
          'gen_ai.usage.input_tokens': response.inputTokens,
          'gen_ai.usage.output_tokens': response.outputTokens,
        });
        this.#metrics.llmTokens.inc({ model: response.model, direction: 'input' }, response.inputTokens);
        this.#metrics.llmTokens.inc({ model: response.model, direction: 'output' }, response.outputTokens);
        if (response.costUsd !== null) {
          set({ 'ops_copilot.llm.cost_usd': response.costUsd });
          this.#metrics.llmCostUsd.inc({ model: response.model }, response.costUsd);
        }
        return response;
      },
    );
  }
}
