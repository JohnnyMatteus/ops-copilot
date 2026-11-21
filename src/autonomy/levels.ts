// Níveis de autonomia (ADR 0002). A ordem do array é a ordem de permissividade.
import { z } from 'zod';

export const AUTONOMY_LEVELS = ['read_only', 'suggest', 'execute_with_approval', 'auto_execute'] as const;

export const AutonomyLevelSchema = z.enum(AUTONOMY_LEVELS);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

function rank(level: AutonomyLevel): number {
  return AUTONOMY_LEVELS.indexOf(level);
}

/** O nível efetivo é sempre o mais restritivo entre os limites aplicáveis. */
export function mostRestrictive(first: AutonomyLevel, ...others: AutonomyLevel[]): AutonomyLevel {
  return others.reduce((current, next) => (rank(next) < rank(current) ? next : current), first);
}

export function isAtLeast(level: AutonomyLevel, floor: AutonomyLevel): boolean {
  return rank(level) >= rank(floor);
}
