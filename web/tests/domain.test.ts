import { describe, expect, it } from 'vitest';
import { IncidentSchema } from '@/api/schemas';
import { requiresServiceConfirmation } from '@/domain/approval';
import { hashColors, shortHash } from '@/domain/hash';
import { effectiveCell } from '@/domain/policy';
import { statusOf } from '@/domain/status';
import { buildTape } from '@/domain/tape';
import { awaitingReport } from './fixtures';

const before = Date.parse('2026-11-20T12:10:00Z');
const after = Date.parse('2026-11-20T12:40:00Z');

describe('estado do incidente', () => {
  it('aguarda aprovação até o prazo e depois expira', () => {
    expect(statusOf(awaitingReport(), before)).toBe('awaiting');
    expect(statusOf(awaitingReport(), after)).toBe('expired');
  });

  it('a decisão humana prevalece sobre o desfecho', () => {
    const resolved = { ...awaitingReport(), resolution: { kind: 'rejected' as const, by: 'a@example.com', reason: 'fora da janela', at: '2026-11-20T12:05:00Z', execution: null } };
    expect(statusOf(resolved, after)).toBe('rejected');
  });
});

describe('API', () => {
  it('relatório antigo, sem linha do tempo nem resolução, ainda é lido', () => {
    const legacy: Record<string, unknown> = { ...awaitingReport() };
    for (const key of ['timeline', 'signals', 'resolution', 'approvalExpiresAt']) delete legacy[key];
    const parsed = IncidentSchema.parse(legacy);
    expect(parsed.timeline).toEqual([]);
    expect(parsed.resolution).toBeNull();
  });

  it('resposta fora do contrato é recusada', () => {
    expect(() => IncidentSchema.parse({ ...awaitingReport(), outcome: 'inventado' })).toThrow();
  });
});

describe('fita do gate', () => {
  it('traz as cinco etapas, o veredicto e as checagens passadas e falhadas', () => {
    const tape = buildTape(awaitingReport());
    expect(tape.map((s) => s.step)).toEqual(['triage', 'collect', 'diagnose', 'decide', 'act']);
    const decide = tape[3];
    expect(decide?.verdict).toBe('needs_approval');
    expect(decide?.checks.map((c) => c.passed)).toEqual([true, false]);
    expect(tape[1]?.stamp).toBe('1 sinais coletados, 1 com erro');
  });

  it('etapas que não rodaram aparecem apagadas', () => {
    const tape = buildTape({ ...awaitingReport(), outcome: 'no_playbook', playbookId: null, diagnosis: null, decision: null, steps: ['triage'], timeline: [awaitingReport().timeline[0]!] });
    expect(tape[0]?.stamp).toMatch(/sem playbook/);
    expect(tape.slice(1).every((s) => !s.reached)).toBe(true);
  });
});

describe('aprovação', () => {
  it('ação de dinheiro exige digitar o nome do serviço', () => {
    expect(requiresServiceConfirmation('payments-events-go', 'notify_oncall')).toBe(true);
    expect(requiresServiceConfirmation('saas-multitenant', 'replay_dlq_batch')).toBe(true);
    expect(requiresServiceConfirmation('saas-multitenant', 'toggle_feature_flag')).toBe(false);
  });
});

describe('elos de hash', () => {
  it('a mesma cor sai do mesmo hash e o hash curto tem 8 caracteres', () => {
    const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    expect(hashColors(hash)).toEqual(hashColors(hash));
    expect(hashColors(hash)).not.toEqual(hashColors('0'.repeat(64)));
    expect(shortHash(hash)).toBe('a1b2c3d4');
  });
});

describe('matriz de política', () => {
  const policy = {
    source: { file: 'p.yaml', commit: 'abc' },
    killSwitch: false,
    defaults: { level: 'read_only' as const, budget: { window: '1h', maxAutoActions: 0 } },
    services: [{ name: 's', level: 'auto_execute' as const, allowedActions: ['replay_dlq_batch', 'notify_oncall'], budget: { window: '1h', maxAutoActions: 1 } }],
    actions: [
      { id: 'replay_dlq_batch', description: '', reversible: false, maxAutonomy: 'execute_with_approval' as const, params: { properties: {} } },
      { id: 'notify_oncall', description: '', reversible: true, maxAutonomy: 'auto_execute' as const, params: { properties: {} } },
      { id: 'restart_pods', description: '', reversible: false, maxAutonomy: 'execute_with_approval' as const, params: { properties: {} } },
    ],
  };

  it('o nível efetivo é o mais restritivo e ação fora da allowlist é bloqueada', () => {
    const service = policy.services[0]!;
    expect(effectiveCell(policy, service, 'replay_dlq_batch')).toBe('execute_with_approval');
    expect(effectiveCell(policy, service, 'notify_oncall')).toBe('auto_execute');
    expect(effectiveCell(policy, service, 'restart_pods')).toBe('not_allowed');
  });

  it('kill switch rebaixa tudo para sugestão', () => {
    expect(effectiveCell({ ...policy, killSwitch: true }, policy.services[0]!, 'notify_oncall')).toBe('suggest');
  });
});
