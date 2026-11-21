// Trilha de auditoria append-only com encadeamento por hash (ADR 0007).
// Cada registro guarda o hash do anterior; alterar ou remover uma linha quebra a verificação.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ObjectStore } from '../storage/object-store.js';

export const AuditEventSchema = z.enum([
  'alert_received',
  'playbook_matched',
  'playbook_missing',
  'signals_collected',
  'diagnosis_completed',
  'diagnosis_failed',
  'decision_made',
  'action_executed',
  'action_failed',
  'approval_requested',
  'approval_granted',
  'approval_rejected',
]);
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditRecordSchema = z.object({
  seq: z.number().int().nonnegative(),
  at: z.iso.datetime(),
  incidentId: z.string(),
  event: AuditEventSchema,
  /** `copilot` ou `human:<e-mail>`. */
  actor: z.string().regex(/^(copilot|human:[^\s@]+@[^\s@]+)$/),
  details: z.record(z.string(), z.unknown()),
  prevHash: z.string(),
  hash: z.string(),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

export type AuditEntry = Pick<AuditRecord, 'incidentId' | 'event' | 'actor' | 'details'>;

export interface AuditLog {
  append(entry: AuditEntry): Promise<AuditRecord>;
  records(): Promise<readonly AuditRecord[]>;
}

const GENESIS = '0'.repeat(64);

/** JSON com chaves ordenadas: o hash não pode depender da ordem de inserção das propriedades. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashOf(record: Omit<AuditRecord, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(record)).digest('hex');
}

/** Encadeia registros e serializa escritas: a ordem do arquivo é a ordem dos eventos. */
export abstract class ChainedAuditLog implements AuditLog {
  #last: { seq: number; hash: string } | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #now: () => Date;

  protected constructor(now: () => Date) {
    this.#now = now;
  }

  append(entry: AuditEntry): Promise<AuditRecord> {
    const next = this.#queue.then(async () => {
      const last = this.#last ?? (await this.loadTail());
      const unsigned = {
        seq: last ? last.seq + 1 : 0,
        at: this.#now().toISOString(),
        ...entry,
        prevHash: last?.hash ?? GENESIS,
      };
      const record = AuditRecordSchema.parse({ ...unsigned, hash: hashOf(unsigned) });
      try {
        await this.write(record);
      } catch (error) {
        // Outra instância pode ter escrito antes: a próxima tentativa relê o fim da cadeia.
        this.#last = null;
        throw error;
      }
      this.#last = { seq: record.seq, hash: record.hash };
      return record;
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }

  abstract records(): Promise<readonly AuditRecord[]>;
  protected abstract write(record: AuditRecord): Promise<void>;

  protected async loadTail(): Promise<{ seq: number; hash: string } | null> {
    const all = await this.records();
    const tail = all.at(-1);
    return tail ? { seq: tail.seq, hash: tail.hash } : null;
  }
}

export class InMemoryAuditLog extends ChainedAuditLog {
  readonly #records: AuditRecord[] = [];

  constructor(now: () => Date = () => new Date()) {
    super(now);
  }

  async records(): Promise<readonly AuditRecord[]> {
    return [...this.#records];
  }

  protected async write(record: AuditRecord): Promise<void> {
    this.#records.push(record);
  }
}

/** Uma linha JSON por registro (JSONL). Pronta para ser enviada a um armazenamento WORM depois. */
export class FileAuditLog extends ChainedAuditLog {
  readonly #path: string;

  constructor(path: string, now: () => Date = () => new Date()) {
    super(now);
    this.#path = path;
  }

  async records(): Promise<readonly AuditRecord[]> {
    let content: string;
    try {
      content = await readFile(this.#path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return content
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => AuditRecordSchema.parse(JSON.parse(line)));
  }

  protected async write(record: AuditRecord): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await appendFile(this.#path, `${JSON.stringify(record)}\n`, 'utf8');
  }
}

export type ChainVerification = { readonly valid: true } | { readonly valid: false; readonly brokenAt: number };

export function verifyChain(records: readonly AuditRecord[]): ChainVerification {
  let prevHash = GENESIS;
  for (const [index, record] of records.entries()) {
    const { hash, ...unsigned } = record;
    if (record.seq !== index || record.prevHash !== prevHash || hashOf(unsigned) !== hash) {
      return { valid: false, brokenAt: index };
    }
    prevHash = hash;
  }
  return { valid: true };
}

/**
 * Um objeto por registro num bucket com object lock (ADR 0010): o armazenamento recusa
 * sobrescrita e remoção durante a retenção, e o encadeamento por hash revela lacunas.
 */
export class ObjectStoreAuditLog extends ChainedAuditLog {
  readonly #store: ObjectStore;
  readonly #prefix: string;

  constructor(store: ObjectStore, prefix = 'audit/', now: () => Date = () => new Date()) {
    super(now);
    this.#store = store;
    this.#prefix = prefix;
  }

  async records(): Promise<readonly AuditRecord[]> {
    const keys = await this.#store.list(this.#prefix);
    const bodies = await Promise.all(keys.map((key) => this.#store.get(key)));
    return bodies.map((body) => AuditRecordSchema.parse(JSON.parse(body)));
  }

  protected async write(record: AuditRecord): Promise<void> {
    // Sequência com zeros à esquerda: a ordem lexicográfica das chaves é a ordem dos eventos.
    const key = `${this.#prefix}${String(record.seq).padStart(12, '0')}.json`;
    await this.#store.putIfAbsent(key, JSON.stringify(record));
  }
}
