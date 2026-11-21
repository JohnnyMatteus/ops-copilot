// Porta da fila de ações aguardando aprovação humana (ChatOps com humano no loop) e o adaptador
// em memória. Pedidos expiram: uma aprovação horas depois decidiria sobre um sistema que já mudou.
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

export interface ApprovalQueue {
  request(incidentId: string, gateInput: GateInput): Promise<PendingApproval>;
  /** Retira o pedido da fila: cada aprovação é usada no máximo uma vez. */
  take(id: string): Promise<ApprovalLookup>;
  /** Pedidos ainda dentro do prazo, do mais antigo para o mais novo. */
  list(): Promise<readonly PendingApproval[]>;
}

export interface ApprovalQueueOptions {
  readonly ttlMs: number;
  readonly now?: () => number;
}

export function newApproval(incidentId: string, gateInput: GateInput, ttlMs: number, now: number): PendingApproval {
  return { id: randomUUID(), incidentId, gateInput, requestedAt: now, expiresAt: now + ttlMs };
}

export class InMemoryApprovalQueue implements ApprovalQueue {
  readonly #pending = new Map<string, PendingApproval>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: ApprovalQueueOptions) {
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
  }

  async request(incidentId: string, gateInput: GateInput): Promise<PendingApproval> {
    const approval = newApproval(incidentId, gateInput, this.#ttlMs, this.#now());
    this.#pending.set(approval.id, approval);
    return approval;
  }

  async take(id: string): Promise<ApprovalLookup> {
    const approval = this.#pending.get(id);
    if (!approval) return { status: 'not_found' };
    this.#pending.delete(id);
    if (this.#now() > approval.expiresAt) return { status: 'expired' };
    return { status: 'found', approval };
  }

  async list(): Promise<readonly PendingApproval[]> {
    const now = this.#now();
    return [...this.#pending.values()].filter((approval) => approval.expiresAt >= now);
  }
}
