import { beforeAll, describe, expect, it } from 'vitest';
import { InMemoryActionBudget, type ActionBudget } from '../../src/autonomy/budget.js';
import { AutonomyGate, evaluate, type GateInput } from '../../src/autonomy/gate.js';
import { AutonomyPolicySchema, resolveServicePolicy, type AutonomyPolicy } from '../../src/autonomy/policy.js';
import type { Playbook } from '../../src/playbooks/schema.js';
import { PlaybookActionSchema } from '../../src/playbooks/schema.js';
import { playbookById } from '../helpers/repo.js';

const basePolicy: AutonomyPolicy = {
  apiVersion: 'ops-copilot/v1',
  kind: 'AutonomyPolicy',
  killSwitch: false,
  defaults: { level: 'read_only', budget: { window: '1h', maxAutoActions: 0 } },
  services: {
    'saas-multitenant': {
      level: 'auto_execute',
      allowedActions: ['notify_oncall', 'toggle_feature_flag', 'scale_deployment'],
      budget: { window: '1h', maxAutoActions: 2 },
    },
    'payments-events-go': {
      level: 'execute_with_approval',
      allowedActions: ['notify_oncall', 'replay_dlq_batch', 'scale_deployment'],
    },
    'kafka-telemetry': {
      level: 'auto_execute',
      allowedActions: ['notify_oncall', 'scale_deployment', 'restart_pods', 'reset_consumer_offsets'],
    },
  },
};

const withPolicy = (patch: Partial<AutonomyPolicy>): AutonomyPolicy => ({ ...basePolicy, ...patch });

let saas: Playbook;
let payments: Playbook;
let telemetry: Playbook;

beforeAll(async () => {
  saas = await playbookById('saas-p99-latency');
  payments = await playbookById('payments-dlq-backlog');
  telemetry = await playbookById('telemetry-consumer-lag');
});

function saasFlagInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    service: 'saas-multitenant',
    playbook: saas,
    hypothesisId: 'noisy_tenant',
    confidence: 0.92,
    proposal: { actionId: 'toggle_feature_flag', params: {} },
    ...overrides,
  };
}

const decide = (input: GateInput, policy = basePolicy, budget = 10) =>
  evaluate(input, resolveServicePolicy(policy, input.service), budget);

describe('evaluate: caminho feliz', () => {
  it('executa automaticamente ação reversível, permitida, prevista e dentro do orçamento', () => {
    const decision = decide(saasFlagInput());
    expect(decision.verdict).toBe('auto_execute');
    expect(decision.action).toEqual({
      id: 'toggle_feature_flag',
      params: { flag: 'reports.heavy_export', enabled: false },
      reversible: true,
    });
  });
});

describe('evaluate: ações fora do limite são bloqueadas', () => {
  it('bloqueia ação que não existe no catálogo', () => {
    const decision = decide(saasFlagInput({ proposal: { actionId: 'drop_database', params: {} } }));
    expect(decision.verdict).toBe('blocked');
    expect(decision.reasons[0]).toMatch(/desconhecida/);
  });

  it('bloqueia nomes herdados de Object.prototype (sem confundir com ações do catálogo)', () => {
    expect(decide(saasFlagInput({ proposal: { actionId: 'constructor', params: {} } })).verdict).toBe('blocked');
    expect(decide(saasFlagInput({ proposal: { actionId: '__proto__', params: {} } })).verdict).toBe('blocked');
  });

  it('bloqueia ação do catálogo que não está na allowlist do serviço', () => {
    const decision = decide(
      saasFlagInput({ hypothesisId: 'cpu_saturation', proposal: { actionId: 'restart_pods', params: { deployment: 'saas-api' } } }),
    );
    expect(decision.verdict).toBe('blocked');
    expect(decision.reasons[0]).toMatch(/allowlist/);
  });

  it('bloqueia ação permitida no serviço mas ausente do playbook', () => {
    const policy = withPolicy({
      services: { ...basePolicy.services, 'saas-multitenant': { level: 'auto_execute', allowedActions: ['restart_pods'] } },
    });
    const decision = decide(saasFlagInput({ proposal: { actionId: 'restart_pods', params: { deployment: 'saas-api' } } }), policy);
    expect(decision.verdict).toBe('blocked');
    expect(decision.reasons[0]).toMatch(/não está prevista no playbook/);
  });

  it('bloqueia ação prevista no playbook para outra hipótese', () => {
    const decision = decide(saasFlagInput({ hypothesisId: 'slow_query' }));
    expect(decision.verdict).toBe('blocked');
    expect(decision.reasons[0]).toMatch(/não se aplica à hipótese slow_query/);
  });

  it('bloqueia parâmetros fora dos limites do catálogo', () => {
    const decision = decide(
      saasFlagInput({
        hypothesisId: 'cpu_saturation',
        proposal: { actionId: 'scale_deployment', params: { replicasDelta: 10 } },
      }),
    );
    expect(decision.verdict).toBe('blocked');
    expect(decision.reasons[0]).toMatch(/replicasDelta/);
  });

  it('bloqueia parâmetros extras que o catálogo não conhece', () => {
    const decision = decide(
      saasFlagInput({
        hypothesisId: 'cpu_saturation',
        proposal: { actionId: 'scale_deployment', params: { replicasDelta: 1, namespace: 'kube-system' } },
      }),
    );
    expect(decision.verdict).toBe('blocked');
  });

  it('parâmetros fixados no playbook prevalecem sobre os propostos pelo LLM', () => {
    const decision = decide(
      saasFlagInput({ proposal: { actionId: 'toggle_feature_flag', params: { flag: 'billing.enabled', enabled: false } } }),
    );
    expect(decision.action?.params).toEqual({ flag: 'reports.heavy_export', enabled: false });
  });

  it('bloqueia tudo em serviço desconhecido (padrão somente leitura, allowlist vazia)', () => {
    const decision = decide(saasFlagInput({ service: 'servico-fantasma' }));
    expect(decision.verdict).toBe('blocked');
  });

  it('bloqueia em serviço configurado como somente leitura, mesmo com ação permitida', () => {
    const policy = withPolicy({
      services: { ...basePolicy.services, 'saas-multitenant': { level: 'read_only', allowedActions: ['toggle_feature_flag'] } },
    });
    const decision = decide(saasFlagInput(), policy);
    expect(decision.verdict).toBe('blocked');
    expect(decision.effectiveLevel).toBe('read_only');
  });
});

describe('evaluate: rebaixamentos de nível', () => {
  it('ação irreversível nunca executa sozinha (teto do catálogo)', () => {
    const decision = decide({
      service: 'kafka-telemetry',
      playbook: telemetry,
      hypothesisId: 'stuck_consumer',
      confidence: 0.99,
      proposal: { actionId: 'restart_pods', params: {} },
    });
    expect(decision.verdict).toBe('needs_approval');
  });

  it('ação destrutiva fica só como sugestão, mesmo em serviço com autonomia total', () => {
    const decision = decide({
      service: 'kafka-telemetry',
      playbook: telemetry,
      hypothesisId: 'poison_record',
      confidence: 0.99,
      proposal: {
        actionId: 'reset_consumer_offsets',
        params: { consumerGroup: 'greenhouse-readings-enricher', topic: 'greenhouse.readings.v1' },
      },
    });
    expect(decision.verdict).toBe('suggest');
  });

  it('o teto do playbook limita o serviço (pagamentos nunca passa de aprovação)', () => {
    const policy = withPolicy({
      services: {
        ...basePolicy.services,
        'payments-events-go': { level: 'auto_execute', allowedActions: ['notify_oncall'] },
      },
    });
    const decision = decide(
      {
        service: 'payments-events-go',
        playbook: payments,
        hypothesisId: 'poison_message',
        confidence: 0.99,
        proposal: { actionId: 'notify_oncall', params: {} },
      },
      policy,
    );
    expect(decision.verdict).toBe('needs_approval');
  });

  it('confiança abaixo do mínimo do playbook pede aprovação', () => {
    const decision = decide(saasFlagInput({ confidence: 0.5 }));
    expect(decision.verdict).toBe('needs_approval');
    expect(decision.reasons.join(' ')).toMatch(/Confiança 0.50 abaixo do mínimo 0.80/);
  });

  it('orçamento esgotado pede aprovação', () => {
    const decision = decide(saasFlagInput(), basePolicy, 0);
    expect(decision.verdict).toBe('needs_approval');
    expect(decision.reasons.join(' ')).toMatch(/Orçamento/);
  });

  it('kill switch rebaixa tudo para sugestão', () => {
    const decision = decide(saasFlagInput(), withPolicy({ killSwitch: true }));
    expect(decision.verdict).toBe('suggest');
    expect(decision.reasons[0]).toMatch(/Kill switch/);
  });
});

describe('AutonomyGate', () => {
  it('consome o orçamento só em execuções automáticas e rebaixa quando acaba', async () => {
    let now = 0;
    const gate = new AutonomyGate(basePolicy, new InMemoryActionBudget(() => now));
    expect((await gate.decide(saasFlagInput())).verdict).toBe('auto_execute');
    expect((await gate.decide(saasFlagInput({ confidence: 0.1 }))).verdict).toBe('needs_approval');
    expect((await gate.decide(saasFlagInput())).verdict).toBe('auto_execute');
    expect((await gate.decide(saasFlagInput())).verdict).toBe('needs_approval');

    now += 60 * 60 * 1000 + 1; // janela de 1h passou
    expect((await gate.decide(saasFlagInput())).verdict).toBe('auto_execute');
  });

  it('orçamento indisponível falha fechado: exige aprovação em vez de executar', async () => {
    const down: ActionBudget = {
      remaining: () => Promise.reject(new Error('redis fora')),
      tryConsume: () => Promise.reject(new Error('redis fora')),
    };
    const decision = await new AutonomyGate(basePolicy, down).decide(saasFlagInput());
    expect(decision.verdict).toBe('needs_approval');
    expect(decision.reasons.join(' ')).toMatch(/indisponível/);
  });

  it('aprovação humana não contorna bloqueio da política vigente', () => {
    const gate = new AutonomyGate(withPolicy({ killSwitch: true }), new InMemoryActionBudget());
    const decision = gate.authorizeApproved(saasFlagInput());
    expect(decision.verdict).toBe('blocked');
    expect(decision.reasons.at(-1)).toMatch(/Aprovação recusada/);
  });

  it('aprovação humana autoriza ação irreversível que a política permite com aprovação', () => {
    const gate = new AutonomyGate(basePolicy, new InMemoryActionBudget());
    const decision = gate.authorizeApproved({
      service: 'payments-events-go',
      playbook: payments,
      hypothesisId: 'downstream_recovered',
      confidence: 0.9,
      proposal: { actionId: 'replay_dlq_batch', params: { maxMessages: 100 } },
    });
    expect(decision.verdict).toBe('needs_approval');
    expect(decision.action?.params).toEqual({ queue: 'payments.events.dlq', maxMessages: 100 });
  });
});

describe('ações inversas fora do rollback', () => {
  it('o gate bloqueia restore_* mesmo com política e playbook permissivos, com parâmetros que o schema aceitaria', () => {
    const permissive = withPolicy({
      services: {
        ...basePolicy.services,
        'payments-events-go': { level: 'auto_execute', allowedActions: ['scale_deployment', 'restore_deployment_replicas'], budget: { window: '1h', maxAutoActions: 5 } },
      },
    });
    const forged: Playbook = {
      ...payments,
      actions: [
        ...payments.actions,
        { action: 'restore_deployment_replicas', when: ['consumer_saturation'], params: {}, rationale: 'forjada' },
      ],
    };
    const decision = decide(
      {
        service: 'payments-events-go',
        playbook: forged,
        hypothesisId: 'consumer_saturation',
        confidence: 1,
        proposal: { actionId: 'restore_deployment_replicas', params: { deployment: 'payments-consumer', replicas: 0, expectedCurrent: 0 } },
      },
      permissive,
    );
    expect(decision.verdict).toBe('blocked');
    expect(decision.checks.find((check) => check.check === 'origem')?.passed).toBe(false);
  });

  it('schemas de playbook e política recusam inversas', () => {
    expect(PlaybookActionSchema.safeParse({ action: 'restore_feature_flag', when: ['x'], rationale: 'r' }).success).toBe(false);
    expect(AutonomyPolicySchema.safeParse({ ...basePolicy, services: { s: { level: 'suggest', allowedActions: ['restore_feature_flag'] } } }).success).toBe(false);
  });
});
