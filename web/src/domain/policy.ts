// Nível efetivo na matriz serviço × ação: o mais restritivo entre o serviço e o teto da ação,
// como o gate calcula (src/autonomy/levels.ts). Ação fora da allowlist é bloqueada.
import type { Level, Policy } from '@/api/schemas';

const ORDER: readonly Level[] = ['read_only', 'suggest', 'execute_with_approval', 'auto_execute'];

export type Cell = Level | 'not_allowed';

export function effectiveCell(policy: Policy, service: Policy['services'][number], actionId: string): Cell {
  const action = policy.actions.find((candidate) => candidate.id === actionId);
  if (!action || !service.allowedActions.includes(actionId)) return 'not_allowed';
  const level = [service.level, action.maxAutonomy].reduce((lowest, next) => (ORDER.indexOf(next) < ORDER.indexOf(lowest) ? next : lowest));
  return policy.killSwitch && ORDER.indexOf(level) > 1 ? 'suggest' : level;
}

/** Resume o limite de um parâmetro a partir do JSON Schema do catálogo. */
export function describeLimit(schema: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(schema['enum'])) parts.push((schema['enum'] as unknown[]).map(String).join(' | '));
  if ('const' in schema) parts.push(`= ${String(schema['const'])}`);
  if (typeof schema['minimum'] === 'number') parts.push(`≥ ${String(schema['minimum'])}`);
  if (typeof schema['maximum'] === 'number') parts.push(`≤ ${String(schema['maximum'])}`);
  if (typeof schema['pattern'] === 'string') parts.push(`/${schema['pattern']}/`);
  return parts.join(' ') || String(schema['type'] ?? '');
}
