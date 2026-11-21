import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakeLlmClient } from '../../src/llm/fake.js';
import { generateStructured, LlmOutputValidationError } from '../../src/llm/structured.js';

const schema = z.strictObject({ hypothesisId: z.enum(['a', 'b']), confidence: z.number().min(0).max(1) });
const messages = [{ role: 'user' as const, content: 'diagnostique' }];

describe('generateStructured', () => {
  it('aceita a primeira resposta válida sem retry', async () => {
    const client = new FakeLlmClient(['{"hypothesisId":"a","confidence":0.9}']);
    const result = await generateStructured({ client, model: 'm', messages, schema });
    expect(result.value).toEqual({ hypothesisId: 'a', confidence: 0.9 });
    expect(result.usage.calls).toBe(1);
    expect(client.requests[0]?.temperature).toBe(0);
  });

  it('aceita JSON embrulhado em bloco de código', async () => {
    const client = new FakeLlmClient(['```json\n{"hypothesisId":"b","confidence":0.4}\n```']);
    const result = await generateStructured({ client, model: 'm', messages, schema });
    expect(result.value.hypothesisId).toBe('b');
  });

  it('faz um retry mostrando ao modelo o erro de validação', async () => {
    const client = new FakeLlmClient(['{"hypothesisId":"z","confidence":0.9}', '{"hypothesisId":"a","confidence":0.9}']);
    const result = await generateStructured({ client, model: 'm', messages, schema });
    expect(result.value.hypothesisId).toBe('a');
    expect(result.usage.calls).toBe(2);
    const retry = client.requests[1]?.messages ?? [];
    expect(retry.at(-2)).toEqual({ role: 'assistant', content: '{"hypothesisId":"z","confidence":0.9}' });
    expect(retry.at(-1)?.content).toMatch(/hypothesisId/);
  });

  it('lança erro explícito depois do retry, com as falhas e o uso acumulado', async () => {
    const client = new FakeLlmClient([
      { content: 'não sei', inputTokens: 10, outputTokens: 2, costUsd: 0.001 },
      { content: '{"hypothesisId":"a","confidence":7}', inputTokens: 12, outputTokens: 3, costUsd: 0.002 },
    ]);
    const error = await generateStructured({ client, model: 'm', messages, schema }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmOutputValidationError);
    const failure = error as LlmOutputValidationError;
    expect(failure.issues.join()).toMatch(/confidence/);
    expect(failure.usage).toEqual({ calls: 2, inputTokens: 22, outputTokens: 5, costUsd: 0.003 });
    expect(client.requests).toHaveLength(2);
  });

  it('custo desconhecido em qualquer chamada torna o total desconhecido', async () => {
    const client = new FakeLlmClient([
      { content: 'x', costUsd: null },
      { content: '{"hypothesisId":"a","confidence":1}', costUsd: 0.01 },
    ]);
    const result = await generateStructured({ client, model: 'm', messages, schema });
    expect(result.usage.costUsd).toBeNull();
  });

  it('erro de transporte não vira retry silencioso', async () => {
    const client = new FakeLlmClient([]);
    await expect(generateStructured({ client, model: 'm', messages, schema })).rejects.toThrow(/sem resposta roteirizada/);
  });
});
