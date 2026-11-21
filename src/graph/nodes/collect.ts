// Etapa 2: coleta métricas e traces em paralelo. Falha de uma fonte vira sinal de erro (o
// diagnóstico vê o que faltou); só sem nenhum sinal útil a investigação para.
import { renderTemplate } from '../../playbooks/registry.js';
import type { MetricSignalSpec, TraceSignalSpec } from '../../playbooks/schema.js';
import type { Signal } from '../../signals/types.js';
import type { InvestigationDeps } from '../deps.js';
import type { InvestigationStateType, InvestigationUpdate } from '../state.js';

export function createCollectNode(deps: InvestigationDeps) {
  return async (state: InvestigationStateType): Promise<InvestigationUpdate> => {
    const { alert, playbook, incidentId } = state;
    if (!playbook) throw new Error('collect: estado sem playbook.');
    const at = deps.now();

    const collectMetric = async (spec: MetricSignalSpec): Promise<Signal> => {
      let query: string;
      try {
        query = renderTemplate(spec.query, alert.labels);
      } catch (error) {
        return { kind: 'error', name: spec.name, source: 'template', message: (error as Error).message };
      }
      try {
        const series = await deps.metricsSource.query({ ...spec, query }, at);
        return { kind: 'metric', name: spec.name, query, series };
      } catch (error) {
        return { kind: 'error', name: spec.name, source: 'prometheus', message: (error as Error).message };
      }
    };
    const collectTraces = async (spec: TraceSignalSpec): Promise<Signal> => {
      try {
        const traces = await deps.traceSource.find(spec, at);
        return { kind: 'trace', name: spec.name, service: spec.service, traces };
      } catch (error) {
        return { kind: 'error', name: spec.name, source: 'jaeger', message: (error as Error).message };
      }
    };

    const signals = await Promise.all([
      ...playbook.signals.metrics.map(collectMetric),
      ...playbook.signals.traces.map(collectTraces),
    ]);
    const failed = signals.filter((signal) => signal.kind === 'error');
    for (const failure of failed) deps.metrics.signalFailures.inc({ source: failure.source });

    await deps.audit.append({
      incidentId,
      event: 'signals_collected',
      actor: 'copilot',
      details: { collected: signals.length - failed.length, failed: failed.map((signal) => signal.name) },
    });
    if (failed.length === signals.length) {
      return { signals, outcome: 'insufficient_signals', failure: 'Nenhum sinal pôde ser coletado.' };
    }
    return { signals };
  };
}
