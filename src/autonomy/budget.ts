// Orçamento de ações automáticas por serviço numa janela deslizante.
// Em memória: reinicia com o processo (trade-off registrado no roteiro de limites de autonomia).

export type Clock = () => number;

export class SlidingWindowBudget {
  readonly #executions = new Map<string, number[]>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  remaining(service: string, windowMs: number, max: number): number {
    return Math.max(0, max - this.#recent(service, windowMs).length);
  }

  /**
   * Verifica e consome numa única chamada síncrona: no event loop do Node não há intercalação
   * entre a checagem e o registro, então duas investigações simultâneas não estouram o limite.
   */
  tryConsume(service: string, windowMs: number, max: number): boolean {
    const recent = this.#recent(service, windowMs);
    if (recent.length >= max) return false;
    recent.push(this.#now());
    this.#executions.set(service, recent);
    return true;
  }

  #recent(service: string, windowMs: number): number[] {
    const cutoff = this.#now() - windowMs;
    return (this.#executions.get(service) ?? []).filter((timestamp) => timestamp > cutoff);
  }
}
