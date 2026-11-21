const UNITS_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;

/** Converte durações no formato `30s`, `15m` ou `1h` para milissegundos. */
export function durationToMs(value: string): number {
  const match = /^(\d+)(s|m|h)$/.exec(value);
  if (!match?.[1] || !match[2]) throw new Error(`Duração inválida: ${value}`);
  return Number(match[1]) * UNITS_MS[match[2] as keyof typeof UNITS_MS];
}
