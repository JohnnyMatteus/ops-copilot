// Fontes de sinais a partir de dados fixos, indexadas pelo nome do sinal do playbook.
// Usadas pelos evals e pelos testes; um nome sem fixture simula a fonte fora do ar.
import type { MetricSignalSpec, TraceSignalSpec } from '../playbooks/schema.js';
import { SignalSourceError, type MetricSeries, type MetricsSource, type TraceSource, type TraceSummary } from './types.js';

export class FixtureMetricsSource implements MetricsSource {
  readonly #fixtures: Readonly<Record<string, MetricSeries[]>>;
  readonly queries: string[] = [];

  constructor(fixtures: Readonly<Record<string, MetricSeries[]>>) {
    this.#fixtures = fixtures;
  }

  async query(spec: MetricSignalSpec): Promise<MetricSeries[]> {
    this.queries.push(spec.query);
    const series = this.#fixtures[spec.name];
    if (!series) throw new SignalSourceError(`Sem dados de exemplo para ${spec.name}.`);
    return series;
  }
}

export class FixtureTraceSource implements TraceSource {
  readonly #fixtures: Readonly<Record<string, TraceSummary[]>>;

  constructor(fixtures: Readonly<Record<string, TraceSummary[]>>) {
    this.#fixtures = fixtures;
  }

  async find(spec: TraceSignalSpec): Promise<TraceSummary[]> {
    const traces = this.#fixtures[spec.name];
    if (!traces) throw new SignalSourceError(`Sem traces de exemplo para ${spec.name}.`);
    return traces;
  }
}
