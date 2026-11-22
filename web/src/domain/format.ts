import { differenceInSeconds, format, formatDistanceToNowStrict } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export const clock = (iso: string) => format(new Date(iso), 'HH:mm:ss');
export const dateTime = (iso: string) => format(new Date(iso), 'dd/MM HH:mm:ss');
export const ago = (iso: string) => formatDistanceToNowStrict(new Date(iso), { locale: ptBR, addSuffix: true });

export const duration = (ms: number) => (ms < 1000 ? `${String(ms)} ms` : `${(ms / 1000).toFixed(1).replace('.', ',')} s`);

/** Relógio regressivo em mono: 12:04, ou "vencido". */
export function countdown(expiresAt: string, now: number): string {
  const seconds = differenceInSeconds(new Date(expiresAt), new Date(now));
  if (seconds <= 0) return 'vencido';
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export const number = (value: number) => new Intl.NumberFormat('pt-BR').format(value);
export const percent = (value: number) => `${String(Math.round(value * 100))}%`;
