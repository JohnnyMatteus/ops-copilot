/** Assinatura mínima de `fetch`, injetável nos testes dos adaptadores HTTP. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
