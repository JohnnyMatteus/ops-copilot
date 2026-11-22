// Teto de custo de LLM por incidente (ADR 0016). Uma instância vale para um incidente: soma o custo
// de cada resposta e recusa a chamada seguinte se o teto foi atingido. É decisão do código, não do prompt.
import type { ChatRequest, ChatResponse, LlmClient } from './client.js';

export class LlmCostCeilingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmCostCeilingError';
  }
}

export class CostCappedLlmClient implements LlmClient {
  readonly #inner: LlmClient;
  readonly #maxCostUsd: number;
  #spentUsd = 0;
  #costUnknown = false;

  constructor(inner: LlmClient, maxCostUsd: number) {
    this.#inner = inner;
    this.#maxCostUsd = maxCostUsd;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Custo desconhecido não é zero: sem como somar, o teto não pode ser garantido, então falha fechado.
    if (this.#costUnknown) throw new LlmCostCeilingError('O provedor não informou o custo da chamada anterior; o teto não pode ser verificado.');
    if (this.#spentUsd >= this.#maxCostUsd) {
      throw new LlmCostCeilingError(`Teto de custo do incidente atingido: US$ ${this.#spentUsd.toFixed(4)} de US$ ${this.#maxCostUsd.toFixed(4)}.`);
    }
    const response = await this.#inner.chat(request);
    if (response.costUsd === null) this.#costUnknown = true;
    else this.#spentUsd += response.costUsd;
    return response;
  }
}
