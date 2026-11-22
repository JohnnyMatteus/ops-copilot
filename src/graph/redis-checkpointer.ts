// Checkpointer do LangGraph no Redis (ADR 0018). Reaproveita o MemorySaver como cache de leitura e
// grava de volta, por thread, tudo o que o grafo persiste, para que uma investigação interrompida
// por queda do processo possa ser retomada por outro. Uma thread é um incidente.
import { MemorySaver } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { Redis } from 'ioredis';

const RETENTION_MS = 24 * 60 * 60 * 1000;

type Snapshot = { storage: MemorySaver['storage'][string]; writes: MemorySaver['writes'] };

/** Uint8Array não sobrevive ao JSON puro: vai e volta como base64. */
const replacer = (_key: string, value: unknown) =>
  value instanceof Uint8Array ? { __b64: Buffer.from(value).toString('base64') } : value;
const reviver = (_key: string, value: unknown) => {
  const encoded = (value as { __b64?: unknown } | null)?.__b64;
  return typeof encoded === 'string' ? new Uint8Array(Buffer.from(encoded, 'base64')) : value;
};

export class RedisCheckpointSaver extends MemorySaver {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #loaded = new Set<string>();

  constructor(redis: Redis, prefix = 'ops-copilot:checkpoint') {
    super();
    this.#redis = redis;
    this.#prefix = prefix;
  }

  override async getTuple(config: RunnableConfig) {
    await this.#hydrate(config);
    return super.getTuple(config);
  }

  override async *list(config: RunnableConfig, options?: Parameters<MemorySaver['list']>[1]) {
    await this.#hydrate(config);
    yield* super.list(config, options);
  }

  override async put(config: RunnableConfig, checkpoint: Parameters<MemorySaver['put']>[1], metadata: Parameters<MemorySaver['put']>[2]) {
    await this.#hydrate(config);
    const next = await super.put(config, checkpoint, metadata);
    await this.#persist(threadOf(config));
    return next;
  }

  override async putWrites(config: RunnableConfig, writes: Parameters<MemorySaver['putWrites']>[1], taskId: string, taskPath?: string) {
    await this.#hydrate(config);
    await super.putWrites(config, writes, taskId, taskPath);
    await this.#persist(threadOf(config));
  }

  override async deleteThread(threadId: string): Promise<void> {
    await super.deleteThread(threadId);
    this.#loaded.delete(threadId);
    await this.#redis.del(this.#key(threadId));
  }

  /**
   * Leitura "do último" (sem checkpoint_id, como na retomada) sempre relê o Redis: outro processo
   * pode ter avançado a thread. Leituras de um checkpoint específico usam o cache.
   */
  async #hydrate(config: RunnableConfig): Promise<void> {
    const threadId = config.configurable?.['thread_id'] as string | undefined;
    if (threadId === undefined) return;
    const latest = config.configurable?.['checkpoint_id'] === undefined;
    if (!latest && this.#loaded.has(threadId)) return;
    const raw = await this.#redis.get(this.#key(threadId));
    if (raw !== null) {
      const snapshot = JSON.parse(raw, reviver) as Snapshot;
      this.storage[threadId] = snapshot.storage;
      Object.assign(this.writes, snapshot.writes);
    }
    this.#loaded.add(threadId);
  }

  async #persist(threadId: string): Promise<void> {
    const writes = Object.fromEntries(
      Object.entries(this.writes).filter(([key]) => (JSON.parse(key) as string[])[0] === threadId),
    );
    const snapshot: Snapshot = { storage: this.storage[threadId] ?? {}, writes };
    await this.#redis.set(this.#key(threadId), JSON.stringify(snapshot, replacer), 'PX', RETENTION_MS);
  }

  #key(threadId: string): string {
    return `${this.#prefix}:${threadId}`;
  }
}

const threadOf = (config: RunnableConfig): string => String(config.configurable?.['thread_id']);
