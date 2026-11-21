// Saída estruturada: toda resposta do LLM passa por um schema Zod, com um retry (ADR 0005).
import type { z } from 'zod';
import type { ChatMessage, ChatResponse, LlmClient } from './client.js';

export interface LlmUsage {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** `null` se alguma chamada não informou custo: somar desconhecido como zero mentiria. */
  readonly costUsd: number | null;
}

export const EMPTY_USAGE: LlmUsage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

export function addUsage(total: LlmUsage, response: Pick<ChatResponse, 'inputTokens' | 'outputTokens' | 'costUsd'>): LlmUsage {
  return {
    calls: total.calls + 1,
    inputTokens: total.inputTokens + response.inputTokens,
    outputTokens: total.outputTokens + response.outputTokens,
    costUsd: total.costUsd === null || response.costUsd === null ? null : total.costUsd + response.costUsd,
  };
}

/** A resposta continuou inválida depois do retry. Carrega o uso para o custo não sumir da conta. */
export class LlmOutputValidationError extends Error {
  readonly issues: readonly string[];
  readonly usage: LlmUsage;

  constructor(issues: readonly string[], usage: LlmUsage) {
    super(`Saída do LLM inválida após ${String(usage.calls)} tentativas: ${issues.join('; ')}`);
    this.name = 'LlmOutputValidationError';
    this.issues = issues;
    this.usage = usage;
  }
}

export interface StructuredRequest<T> {
  readonly client: LlmClient;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly schema: z.ZodType<T>;
  /** Chamado a cada resposta, inclusive as inválidas (telemetria de tokens e custo). */
  readonly onResponse?: (response: ChatResponse, attempt: number) => void;
}

export interface StructuredResult<T> {
  readonly value: T;
  readonly usage: LlmUsage;
}

const MAX_ATTEMPTS = 2;

export async function generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
  const messages: ChatMessage[] = [...request.messages];
  let usage = EMPTY_USAGE;
  let issues: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await request.client.chat({ model: request.model, temperature: 0, messages });
    usage = addUsage(usage, response);
    request.onResponse?.(response, attempt);

    const outcome = validate(response.content, request.schema);
    if (outcome.ok) return { value: outcome.value, usage };
    issues = outcome.issues;
    // O retry mostra ao modelo a própria resposta e o que estava errado, sem repetir o prompt inteiro.
    messages.push(
      { role: 'assistant', content: response.content },
      {
        role: 'user',
        content: `A resposta anterior não passou na validação: ${issues.join('; ')}. Responda somente com o JSON corrigido.`,
      },
    );
  }
  throw new LlmOutputValidationError(issues, usage);
}

type Validation<T> = { ok: true; value: T } | { ok: false; issues: string[] };

function validate<T>(content: string, schema: z.ZodType<T>): Validation<T> {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(content));
  } catch {
    return { ok: false, issues: ['resposta não é JSON válido'] };
  }
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, issues: result.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`) };
}

/** Modelos às vezes embrulham o JSON em ```json ... ```; isso não é erro de conteúdo. */
function stripCodeFence(content: string): string {
  const match = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(content);
  return match?.[1] ?? content;
}
