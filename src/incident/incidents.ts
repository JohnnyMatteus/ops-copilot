// Porta do repositório de incidentes investigados (lido pela API) e o adaptador em memória.
import type { ExecutionResult } from '../executor/executor.js';
import type { IncidentReport } from './investigator.js';

/** Decisão humana sobre o incidente. A identidade vem da credencial do operador, nunca do corpo. */
export interface Resolution {
  readonly kind: 'approved' | 'rejected' | 'cancelled' | 'blocked';
  readonly by: string;
  /** Obrigatório na recusa e no cancelamento; opcional na aprovação. */
  readonly reason: string | null;
  readonly at: string;
  readonly execution: ExecutionResult | null;
}

export interface IncidentRepository {
  save(report: IncidentReport): Promise<void>;
  get(incidentId: string): Promise<IncidentReport | null>;
  /** Mais recentes primeiro. */
  list(limit: number): Promise<readonly IncidentReport[]>;
}

export class InMemoryIncidentRepository implements IncidentRepository {
  readonly #reports = new Map<string, IncidentReport>();

  async save(report: IncidentReport): Promise<void> {
    this.#reports.set(report.incidentId, report);
  }

  async get(incidentId: string): Promise<IncidentReport | null> {
    return this.#reports.get(incidentId) ?? null;
  }

  async list(limit: number): Promise<readonly IncidentReport[]> {
    return [...this.#reports.values()].reverse().slice(0, limit);
  }
}
