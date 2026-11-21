// Raiz de composição: monta adaptadores reais a partir do ambiente. Único lugar que conhece todos.
import { FileAuditLog, ObjectStoreAuditLog, type AuditLog } from './autonomy/audit.js';
import { SlidingWindowBudget } from './autonomy/budget.js';
import { AutonomyGate } from './autonomy/gate.js';
import { loadAutonomyPolicy } from './autonomy/policy.js';
import type { Env } from './config/env.js';
import { createExecutor } from './executor/executor.js';
import { createHttpServer } from './http/server.js';
import { ApprovalService } from './incident/approval-service.js';
import { ApprovalStore } from './incident/approvals.js';
import { Investigator } from './incident/investigator.js';
import { createLlmClient } from './llm/factory.js';
import { loadPlaybooks } from './playbooks/registry.js';
import { JaegerTraceSource } from './signals/jaeger.js';
import { S3ObjectStore } from './storage/s3-object-store.js';
import { PrometheusMetricsSource } from './signals/prometheus.js';
import { InstrumentedLlmClient } from './telemetry/instrumented-llm.js';
import type { Logger } from './telemetry/logger.js';
import { CopilotMetrics } from './telemetry/metrics.js';
import { setupTracing } from './telemetry/tracing.js';

export const VERSION = '0.1.0';

export async function createApp(env: Env, logger: Logger) {
  const [playbooks, policy] = await Promise.all([
    loadPlaybooks(env.PLAYBOOKS_DIR),
    loadAutonomyPolicy(env.AUTONOMY_POLICY_FILE),
  ]);
  const tracing = setupTracing({ otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT, version: VERSION });
  const metrics = new CopilotMetrics();
  const audit = createAuditLog(env);
  const gate = new AutonomyGate(policy, new SlidingWindowBudget());
  const executor = createExecutor(env.EXECUTION_MODE);
  const approvals = new ApprovalStore({ ttlMs: env.APPROVAL_TTL_MINUTES * 60_000 });
  const llm = new InstrumentedLlmClient(await createLlmClient(env), tracing.tracer, metrics);

  const investigator = new Investigator({
    playbooks,
    metricsSource: new PrometheusMetricsSource({ baseUrl: env.PROMETHEUS_URL }),
    traceSource: new JaegerTraceSource({ baseUrl: env.JAEGER_URL }),
    llm,
    model: env.LLM_MODEL,
    gate,
    executor,
    approvals,
    audit,
    tracer: tracing.tracer,
    metrics,
    now: () => new Date(),
  });

  const server = createHttpServer({
    investigate: async (alert) => {
      const report = await investigator.investigate(alert);
      if (report) logger.info({ report }, 'investigação concluída');
      else logger.info({ fingerprint: alert.fingerprint }, 'alerta repetido ignorado');
    },
    approvals,
    approvalService: new ApprovalService({ approvals, gate, executor, audit }),
    registry: metrics.registry,
    logger,
    webhookToken: env.WEBHOOK_TOKEN,
    approvalToken: env.APPROVAL_TOKEN,
  });

  logger.info(
    { playbooks: playbooks.all.map((p) => `${p.metadata.id}@${p.metadata.version}`), executionMode: executor.mode, auditSink: env.AUDIT_SINK, killSwitch: policy.killSwitch },
    'copiloto configurado',
  );
  return { server, shutdown: () => tracing.shutdown() };
}

function createAuditLog(env: Env): AuditLog {
  if (env.AUDIT_SINK === 'file') return new FileAuditLog(env.AUDIT_LOG_PATH);
  const store = new S3ObjectStore({ bucket: env.AUDIT_S3_BUCKET, region: env.AWS_REGION, endpoint: env.S3_ENDPOINT });
  return new ObjectStoreAuditLog(store, env.AUDIT_S3_PREFIX);
}
