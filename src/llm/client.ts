// Porta da camada LLM (ADR 0004). Sem fetch e sem process.env: os adaptadores ficam fora do domínio.

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ChatRequest {
  readonly model: string;
  readonly temperature: number;
  readonly messages: readonly ChatMessage[];
}

export interface ChatResponse {
  readonly content: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Custo em dólares; `null` quando o provedor não informa. */
  readonly costUsd: number | null;
}

export interface LlmClient {
  chat(request: ChatRequest): Promise<ChatResponse>;
}

/** Falha de transporte ou de formato do provedor. Nunca inclui o corpo da resposta (pode ecoar o prompt). */
export class LlmHttpError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'LlmHttpError';
    this.status = status;
  }
}
