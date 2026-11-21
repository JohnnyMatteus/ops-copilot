// Modelo falso com respostas roteirizadas: o único LlmClient usado em testes e no eval do CI.
import type { ChatRequest, ChatResponse, LlmClient } from './client.js';

export type ScriptedResponse = string | (Partial<ChatResponse> & { readonly content: string });

export class FakeLlmClient implements LlmClient {
  readonly #script: ScriptedResponse[];
  readonly #requests: ChatRequest[] = [];

  constructor(script: readonly ScriptedResponse[]) {
    this.#script = [...script];
  }

  get requests(): readonly ChatRequest[] {
    return this.#requests;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.#requests.push(request);
    const next = this.#script.shift();
    if (next === undefined) {
      throw new Error(`FakeLlmClient: sem resposta roteirizada para a chamada ${String(this.#requests.length)}.`);
    }
    const scripted = typeof next === 'string' ? { content: next } : next;
    return { model: request.model, inputTokens: 100, outputTokens: 50, costUsd: 0, ...scripted };
  }
}
