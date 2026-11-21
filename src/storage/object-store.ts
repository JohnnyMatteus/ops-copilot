// Porta de armazenamento de objetos (S3 ou compatível). O domínio não conhece o SDK da AWS.

export interface ObjectStore {
  /** Grava só se a chave não existir; nunca sobrescreve. */
  putIfAbsent(key: string, body: string): Promise<void>;
  /** Chaves sob o prefixo, em ordem lexicográfica. */
  list(prefix: string): Promise<string[]>;
  get(key: string): Promise<string>;
}

export class ObjectAlreadyExistsError extends Error {
  constructor(key: string) {
    super(`Objeto ${key} já existe e não pode ser sobrescrito.`);
    this.name = 'ObjectAlreadyExistsError';
  }
}

/** Implementação em memória para testes; respeita a mesma regra de não sobrescrever. */
export class InMemoryObjectStore implements ObjectStore {
  readonly #objects = new Map<string, string>();

  async putIfAbsent(key: string, body: string): Promise<void> {
    if (this.#objects.has(key)) throw new ObjectAlreadyExistsError(key);
    this.#objects.set(key, body);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.#objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  async get(key: string): Promise<string> {
    const body = this.#objects.get(key);
    if (body === undefined) throw new Error(`Objeto ${key} não encontrado.`);
    return body;
  }
}
