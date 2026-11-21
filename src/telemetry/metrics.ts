// Métricas Prometheus do próprio copiloto. Registro injetado (não o global) para isolar testes.
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export class CopilotMetrics {
  readonly registry: Registry;
  readonly incidents: Counter<'service' | 'outcome'>;
  readonly decisions: Counter<'service' | 'action' | 'verdict'>;
  readonly llmCalls: Counter<'model' | 'result'>;
  readonly llmTokens: Counter<'model' | 'direction'>;
  readonly llmCostUsd: Counter<'model'>;
  readonly signalFailures: Counter<'source'>;
  readonly nodeDuration: Histogram<'node'>;
  readonly approvals: Counter<'service' | 'outcome'>;

  constructor(registry: Registry = new Registry()) {
    this.registry = registry;
    const registers = [registry];
    this.incidents = new Counter({
      name: 'ops_copilot_incidents_total',
      help: 'Investigações concluídas, por serviço e desfecho.',
      labelNames: ['service', 'outcome'],
      registers,
    });
    this.decisions = new Counter({
      name: 'ops_copilot_decisions_total',
      help: 'Decisões do gate de autonomia, por ação e veredito.',
      labelNames: ['service', 'action', 'verdict'],
      registers,
    });
    this.llmCalls = new Counter({
      name: 'ops_copilot_llm_calls_total',
      help: 'Chamadas ao LLM, separando respostas válidas e inválidas no schema.',
      labelNames: ['model', 'result'],
      registers,
    });
    this.llmTokens = new Counter({
      name: 'ops_copilot_llm_tokens_total',
      help: 'Tokens consumidos, por direção (input/output).',
      labelNames: ['model', 'direction'],
      registers,
    });
    this.llmCostUsd = new Counter({
      name: 'ops_copilot_llm_cost_usd_total',
      help: 'Custo informado pelo provedor, em dólares.',
      labelNames: ['model'],
      registers,
    });
    this.signalFailures = new Counter({
      name: 'ops_copilot_signal_failures_total',
      help: 'Falhas ao coletar sinais, por fonte.',
      labelNames: ['source'],
      registers,
    });
    this.nodeDuration = new Histogram({
      name: 'ops_copilot_node_duration_seconds',
      help: 'Duração de cada etapa do grafo de investigação.',
      labelNames: ['node'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30],
      registers,
    });
    this.approvals = new Counter({
      name: 'ops_copilot_approvals_total',
      help: 'Pedidos de aprovação resolvidos por humanos, por desfecho.',
      labelNames: ['service', 'outcome'],
      registers,
    });
  }

  /** Pedidos pendentes lidos da fila a cada coleta: o valor vem do Redis, não do processo. */
  observePendingApprovals(count: () => Promise<number>): void {
    new Gauge({
      name: 'ops_copilot_approvals_pending',
      help: 'Pedidos de aprovação aguardando decisão humana.',
      registers: [this.registry],
      async collect() {
        this.set(await count());
      },
    });
  }
}
