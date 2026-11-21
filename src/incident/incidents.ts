// Porta do repositório de incidentes investigados (lido pela API) e o adaptador em memória.
import type { IncidentReport } from './investigator.js';

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
