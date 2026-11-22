// Cliente HTTP do serviço de feature flags. Contrato esperado (README): GET/PUT /flags/{flag} com
// corpo {"enabled": boolean}. Não foi exercitado contra um serviço real, só contra dublê.
import { z } from 'zod';
import type { FetchLike } from '../shared/fetch.js';
import type { FeatureFlagPort } from './ports.js';

const FlagSchema = z.object({ enabled: z.boolean() });

export class HttpFeatureFlagClient implements FeatureFlagPort {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: FetchLike;

  constructor(options: { baseUrl: string; token: string; fetch?: FetchLike }) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#token = options.token;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async isEnabled(flag: string): Promise<boolean> {
    const response = await this.#call('GET', flag);
    const parsed = FlagSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new Error(`Resposta do serviço de flags fora do contrato para ${flag}.`);
    return parsed.data.enabled;
  }

  async set(flag: string, enabled: boolean): Promise<void> {
    await this.#call('PUT', flag, { enabled });
  }

  async #call(method: 'GET' | 'PUT', flag: string, body?: unknown): Promise<Response> {
    const response = await this.#fetch(`${this.#baseUrl}/flags/${encodeURIComponent(flag)}`, {
      method,
      headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Serviço de flags respondeu HTTP ${String(response.status)} (${method} ${flag}).`);
    return response;
  }
}
