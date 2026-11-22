// Três quadradinhos cuja cor deriva do próprio hash: dois hashes iguais ficam visualmente iguais.
export function hashColors(hash: string): [string, string, string] {
  const color = (hex: string) => {
    const value = Number.parseInt(hex, 16);
    return `hsl(${String(value % 360)} 55% 62%)`;
  };
  return [color(hash.slice(0, 3)), color(hash.slice(3, 6)), color(hash.slice(6, 9))];
}

export const shortHash = (hash: string) => hash.slice(0, 8);
