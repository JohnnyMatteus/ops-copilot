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

/** Rollback já feito (ou tentado) neste incidente. */
export interface RollbackRecord {
  readonly by: string;
  readonly reason: string;
  readonly at: string;
  readonly execution: ExecutionResult;
}

export interface IncidentRepository {
  save(report: IncidentReport): Promise<void>;
  get(incidentId: string): Promise<IncidentReport | null>;
  /** Mais recentes primeiro. */
  list(limit: number): Promise<readonly IncidentReport[]>;
  /** Reserva o direito de reverter o incidente: só o primeiro chamador recebe `true`. */
  claimRollback(incidentId: string): Promise<boolean>;
  /** Devolve a reserva quando o rollback não chegou a executar (bloqueado pelo gate). */
  releaseRollback(incidentId: string): Promise<void>;
}

export class InMemoryIncidentRepository implements IncidentRepository {
  readonly #reports = new Map<string, IncidentReport>();
  readonly #claimed = new Set<string>();

  async claimRollback(incidentId: string): Promise<boolean> {
    if (this.#claimed.has(incidentId)) return false;
    this.#claimed.add(incidentId);
    return true;
  }

  async releaseRollback(incidentId: string): Promise<void> {
    this.#claimed.delete(incidentId);
  }

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
