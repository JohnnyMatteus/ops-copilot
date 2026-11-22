import { ofetch, type FetchError } from 'ofetch';
import type { z } from 'zod';
import { setToken, token } from '@/auth/session';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const http = ofetch.create({
  baseURL: '/api',
  retry: 0,
  onRequest({ options }) {
    if (token.value) options.headers.set('Authorization', `Bearer ${token.value}`);
  },
});

async function call<S extends z.ZodType>(schema: S, path: string, init: Parameters<typeof http>[1] = {}): Promise<z.infer<S>> {
  try {
    return schema.parse(await http(path, init));
  } catch (error) {
    const failure = error as FetchError<{ error?: string }>;
    if (failure.status === 401 && token.value) setToken(null);
    if (failure.status) {
      throw new ApiError(failure.status, failure.data?.error ?? `Falha ${String(failure.status)} em ${path}`, failure.data);
    }
    throw error;
  }
}

export const get = <S extends z.ZodType>(schema: S, path: string, query?: Record<string, string>) =>
  call(schema, path, query ? { query } : {});

/** Respostas 4xx esperadas (409, 410) viram `ApiError` com o corpo, e o painel mostra o motivo. */
export const post = <S extends z.ZodType>(schema: S, path: string, body: Record<string, unknown>) => call(schema, path, { method: 'POST', body });
