// Ações aguardando aprovação humana (ChatOps com humano no loop). Pedidos expiram:
// uma aprovação horas depois decidiria sobre um sistema que já mudou.
import { randomUUID } from 'node:crypto';
import type { GateInput } from '../autonomy/gate.js';

export interface PendingApproval {
  readonly id: string;
  readonly incidentId: string;
  readonly gateInput: GateInput;
  readonly requestedAt: number;
  readonly expiresAt: number;
}

export type ApprovalLookup =
  | { readonly status: 'found'; readonly approval: PendingApproval }
  | { readonly status: 'not_found' | 'expired' };

export class ApprovalStore {
  readonly #pending = new Map<string, PendingApproval>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: { ttlMs: number; now?: () => number }) {
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
  }

  request(incidentId: string, gateInput: GateInput): PendingApproval {
    const requestedAt = this.#now();
    const approval = { id: randomUUID(), incidentId, gateInput, requestedAt, expiresAt: requestedAt + this.#ttlMs };
    this.#pending.set(approval.id, approval);
    return approval;
  }

  /** Retira o pedido da fila: cada aprovação é usada no máximo uma vez. */
  take(id: string): ApprovalLookup {
    const approval = this.#pending.get(id);
    if (!approval) return { status: 'not_found' };
    this.#pending.delete(id);
    if (this.#now() > approval.expiresAt) return { status: 'expired' };
    return { status: 'found', approval };
  }

  list(): readonly PendingApproval[] {
    const now = this.#now();
    return [...this.#pending.values()].filter((approval) => approval.expiresAt >= now);
  }
}
