import { describe, expect, it } from 'vitest';
import { LlmHttpError } from '../../src/llm/client.js';
import { OpenAiCompatibleClient } from '../../src/llm/openai-compatible.js';
import type { FetchLike } from '../../src/shared/fetch.js';

const request = { model: 'modelo-x', temperature: 0, messages: [{ role: 'user' as const, content: 'oi' }] };

function fakeFetch(status: number, body: unknown, calls: { url: string; init: RequestInit }[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
}

const completion = (usage?: object) => ({
  model: 'modelo-x',
  choices: [{ message: { content: '{"ok":true}' } }],
  ...(usage ? { usage } : {}),
});

describe('OpenAiCompatibleClient', () => {
  it('chama /chat/completions pedindo JSON e lê tokens e custo do OpenRouter', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new OpenAiCompatibleClient({
      provider: 'openrouter',
      baseUrl: 'https://llm.example.com/api/v1/',
      apiKey: 'chave-de-teste',
      fetch: fakeFetch(200, completion({ prompt_tokens: 30, completion_tokens: 7, cost: 0.0004 }), calls),
    });
    const response = await client.chat(request);
    expect(response).toEqual({ content: '{"ok":true}', model: 'modelo-x', inputTokens: 30, outputTokens: 7, costUsd: 0.0004 });
    expect(calls[0]?.url).toBe('https://llm.example.com/api/v1/chat/completions');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['response_format']).toEqual({ type: 'json_object' });
    expect((calls[0]?.init.headers as Record<string, string>)['Authorization']).toBe('Bearer chave-de-teste');
  });

  it('OpenRouter sem custo informado devolve custo desconhecido', async () => {
    const client = new OpenAiCompatibleClient({
      provider: 'openrouter',
      baseUrl: 'https://llm.example.com',
      apiKey: 'k',
      fetch: fakeFetch(200, completion({ prompt_tokens: 1, completion_tokens: 1 })),
    });
    expect((await client.chat(request)).costUsd).toBeNull();
  });

  it('Ollama local tem custo zero e não envia Authorization', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new OpenAiCompatibleClient({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      fetch: fakeFetch(200, completion(), calls),
    });
    expect((await client.chat(request)).costUsd).toBe(0);
    expect((calls[0]?.init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('exige chave para o OpenRouter', () => {
    expect(() => new OpenAiCompatibleClient({ provider: 'openrouter', baseUrl: 'https://llm.example.com' })).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });

  it('HTTP de erro vira LlmHttpError sem ecoar o corpo', async () => {
    const client = new OpenAiCompatibleClient({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      fetch: fakeFetch(429, { error: 'segredo ecoado' }),
    });
    const error = await client.chat(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmHttpError);
    expect((error as LlmHttpError).status).toBe(429);
    expect((error as Error).message).not.toMatch(/segredo/);
  });

  it('falha de rede vira LlmHttpError sem status', async () => {
    const client = new OpenAiCompatibleClient({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(client.chat(request)).rejects.toMatchObject({ name: 'LlmHttpError', status: null });
  });

  it('resposta fora do formato de chat completions é erro', async () => {
    const client = new OpenAiCompatibleClient({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      fetch: fakeFetch(200, { choices: [] }),
    });
    await expect(client.chat(request)).rejects.toThrow(/fora do formato/);
  });
});
