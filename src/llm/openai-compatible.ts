// Adaptador para chat completions compatível com OpenAI: OpenRouter (produção) e Ollama (local).
import { z } from 'zod';
import type { FetchLike } from '../shared/fetch.js';
import { LlmHttpError, type ChatRequest, type ChatResponse, type LlmClient } from './client.js';

export type LlmProvider = 'openrouter' | 'ollama';

export interface OpenAiCompatibleOptions {
  readonly provider: LlmProvider;
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
}

const CompletionSchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z
    .object({
      prompt_tokens: z.number().nonnegative(),
      completion_tokens: z.number().nonnegative(),
      // OpenRouter devolve o custo da chamada em dólares dentro de `usage`.
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
});

export class OpenAiCompatibleClient implements LlmClient {
  readonly #options: OpenAiCompatibleOptions;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;

  constructor(options: OpenAiCompatibleOptions) {
    if (options.provider === 'openrouter' && !options.apiKey) {
      throw new Error('OPENROUTER_API_KEY é obrigatória para o provedor openrouter.');
    }
    this.#options = options;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const where = `${this.#options.provider} (${request.model})`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.#options.apiKey) headers['Authorization'] = `Bearer ${this.#options.apiKey}`;

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: request.model,
          temperature: request.temperature,
          messages: request.messages,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 60_000),
      });
    } catch {
      throw new LlmHttpError(`Falha de rede ao chamar ${where}.`);
    }
    if (!response.ok) throw new LlmHttpError(`${where} respondeu HTTP ${String(response.status)}.`, response.status);

    const parsed = CompletionSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new LlmHttpError(`Resposta de ${where} fora do formato de chat completions.`);

    const { choices, usage, model } = parsed.data;
    return {
      content: choices[0]?.message.content ?? '',
      model: model ?? request.model,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      // Ollama roda local: custo zero. OpenRouter sem `cost` vira desconhecido, não zero.
      costUsd: this.#options.provider === 'ollama' ? 0 : (usage?.cost ?? null),
    };
  }
}
