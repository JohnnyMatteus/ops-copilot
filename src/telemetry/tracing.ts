// Traces OpenTelemetry do copiloto: um span por investigação, um por etapa e um por chamada ao LLM.
import { context, SpanStatusCode, type Attributes, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, TracerProvider, type SpanProcessor } from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export const TRACER_NAME = 'ops-copilot';

/** Liga o contexto assíncrono uma vez por processo; sem ele os spans não se aninham. */
let contextManagerEnabled = false;
function enableContextManager(): void {
  if (contextManagerEnabled) return;
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  contextManagerEnabled = true;
}

export interface TracingHandle {
  readonly tracer: Tracer;
  shutdown(): Promise<void>;
}

/** Sem endpoint OTLP, o tracer existe mas não exporta (útil em desenvolvimento sem Jaeger). */
export function setupTracing(options: { otlpEndpoint?: string | undefined; version: string }): TracingHandle {
  const processors: SpanProcessor[] = options.otlpEndpoint
    ? [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${options.otlpEndpoint.replace(/\/+$/, '')}/v1/traces` }) })]
    : [];
  return createTracing(processors, options.version);
}

export function createTracing(spanProcessors: SpanProcessor[], version = '0.0.0-test'): TracingHandle {
  enableContextManager();
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: TRACER_NAME, [ATTR_SERVICE_VERSION]: version }),
    spanProcessors,
  });
  return { tracer: provider.getTracer(TRACER_NAME, version), shutdown: () => provider.shutdown() };
}

/** Executa `fn` dentro de um span ativo; exceções marcam o span com erro e são relançadas. */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: Attributes,
  fn: (setAttributes: (attrs: Attributes) => void) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn((attrs) => span.setAttributes(attrs));
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
