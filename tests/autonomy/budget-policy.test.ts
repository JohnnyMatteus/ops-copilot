import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SlidingWindowBudget } from '../../src/autonomy/budget.js';
import { mostRestrictive } from '../../src/autonomy/levels.js';
import { loadAutonomyPolicy, PolicyValidationError, resolveServicePolicy } from '../../src/autonomy/policy.js';
import { realPolicy } from '../helpers/repo.js';

describe('SlidingWindowBudget', () => {
  it('libera de novo conforme execuções saem da janela', () => {
    let now = 1_000;
    const budget = new SlidingWindowBudget(() => now);
    expect(budget.tryConsume('svc', 10_000, 2)).toBe(true);
    now += 5_000;
    expect(budget.tryConsume('svc', 10_000, 2)).toBe(true);
    expect(budget.tryConsume('svc', 10_000, 2)).toBe(false);
    expect(budget.remaining('svc', 10_000, 2)).toBe(0);
    now += 5_001; // a primeira saiu da janela
    expect(budget.remaining('svc', 10_000, 2)).toBe(1);
  });

  it('orçamento zero nunca libera', () => {
    expect(new SlidingWindowBudget().tryConsume('svc', 60_000, 0)).toBe(false);
  });

  it('serviços têm saldos independentes', () => {
    const budget = new SlidingWindowBudget(() => 0);
    expect(budget.tryConsume('a', 60_000, 1)).toBe(true);
    expect(budget.tryConsume('b', 60_000, 1)).toBe(true);
    expect(budget.tryConsume('a', 60_000, 1)).toBe(false);
  });
});

describe('níveis de autonomia', () => {
  it('o nível efetivo é o mais restritivo', () => {
    expect(mostRestrictive('auto_execute', 'execute_with_approval', 'suggest')).toBe('suggest');
    expect(mostRestrictive('auto_execute')).toBe('auto_execute');
    expect(mostRestrictive('read_only', 'auto_execute')).toBe('read_only');
  });
});

describe('política de autonomia', () => {
  it('o arquivo versionado é válido e pagamentos nunca executa sozinho', async () => {
    const policy = await realPolicy();
    const payments = resolveServicePolicy(policy, 'payments-events-go');
    expect(payments.level).toBe('execute_with_approval');
    expect(payments.budget.maxAutoActions).toBe(0);
    expect(policy.killSwitch).toBe(false);
  });

  it('serviço fora da política herda somente leitura sem ações', async () => {
    const resolved = resolveServicePolicy(await realPolicy(), 'servico-novo');
    expect(resolved.level).toBe('read_only');
    expect(resolved.allowedActions.size).toBe(0);
  });

  it('rejeita ação desconhecida na allowlist com mensagem que aponta o campo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ops-copilot-policy-'));
    const path = join(dir, 'policy.yaml');
    await writeFile(
      path,
      `apiVersion: ops-copilot/v1
kind: AutonomyPolicy
killSwitch: false
defaults: { level: read_only, budget: { window: 1h, maxAutoActions: 0 } }
services:
  svc: { level: auto_execute, allowedActions: [delete_cluster] }
`,
    );
    await expect(loadAutonomyPolicy(path)).rejects.toThrow(PolicyValidationError);
    await expect(loadAutonomyPolicy(path)).rejects.toThrow(/services\.svc\.allowedActions\.0/);
  });
});
