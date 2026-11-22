import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv } from '../../src/config/env.js';
import { DryRunExecutor } from '../../src/executor/executor.js';
import { createExecutor } from '../../src/executor/factory.js';

const base = { WEBHOOK_TOKEN: 'w'.repeat(16), OPERATOR_TOKENS: `plantao@example.com=${'a'.repeat(16)}` };

describe('configuração', () => {
  it('aplica padrões seguros: dry-run, Ollama local e Prometheus/Jaeger locais', () => {
    const env = loadEnv(base);
    expect(env.EXECUTION_MODE).toBe('dry-run');
    expect(env.LLM_PROVIDER).toBe('ollama');
    expect(env.PROMETHEUS_URL).toBe('http://localhost:9090');
  });

  it('OpenRouter sem chave é erro que cita a variável', () => {
    expect(() => loadEnv({ ...base, LLM_PROVIDER: 'openrouter' })).toThrow(/OPENROUTER_API_KEY/);
  });

  it('tokens curtos ou iguais são recusados', () => {
    expect(() => loadEnv({ ...base, WEBHOOK_TOKEN: 'curto' })).toThrow(ConfigError);
    expect(() => loadEnv({ ...base, OPERATOR_TOKENS: `plantao@example.com=${base.WEBHOOK_TOKEN}` })).toThrow(/WEBHOOK_TOKEN/);
    expect(() => loadEnv({ ...base, OPERATOR_TOKENS: 'plantao@example.com=curto' })).toThrow(/16 caracteres/);
    expect(() => loadEnv({ ...base, OPERATOR_TOKENS: 'sem-email=aaaaaaaaaaaaaaaa' })).toThrow(/e-mail=token/);
  });

  it('exige OPERATOR_TOKENS ou OIDC_ISSUER_URL', () => {
    expect(() => loadEnv({ WEBHOOK_TOKEN: base.WEBHOOK_TOKEN })).toThrow(/OPERATOR_TOKENS/);
    expect(loadEnv({ WEBHOOK_TOKEN: base.WEBHOOK_TOKEN, OIDC_ISSUER_URL: 'http://localhost:8180/realms/platform' }).OIDC_AUDIENCE).toBe(
      'ops-copilot',
    );
  });

  it('a mensagem de erro não vaza o valor das variáveis', () => {
    const secret = 'sk-valor-que-nao-pode-vazar';
    const error = (() => {
      try {
        loadEnv({ ...base, WEBHOOK_TOKEN: secret, OPERATOR_TOKENS: `plantao@example.com=${secret}` });
      } catch (caught) {
        return caught as Error;
      }
      throw new Error('loadEnv deveria ter falhado');
    })();
    expect(error.message).toMatch(/OPERATOR_TOKENS/);
    expect(error.message).not.toContain(secret);
  });
});

describe('Slack no ambiente', () => {
  it('variáveis SLACK_* vazias, como o compose as repassa, valem como desligadas', () => {
    const env = loadEnv({ ...base, SLACK_SIGNING_SECRET: '', SLACK_USERS: '', SLACK_BOT_TOKEN: '', SLACK_APPROVAL_CHANNEL: '', SLACK_API_URL: '' });
    expect(env.SLACK_SIGNING_SECRET).toBeUndefined();
    expect(env.SLACK_API_URL).toBe('https://slack.com/api');
  });

  it('segredo sem mapa de usuários, ou usuário malformado, é erro que cita a variável', () => {
    expect(() => loadEnv({ ...base, SLACK_SIGNING_SECRET: 's'.repeat(20) })).toThrow(/SLACK_USERS/);
    expect(() => loadEnv({ ...base, SLACK_SIGNING_SECRET: 's'.repeat(20), SLACK_USERS: 'ana=ana@example.com' })).toThrow(/SLACK_USERS/);
  });
});

describe('executor', () => {
  it('dry-run é o padrão e descreve a ação sem executá-la', async () => {
    const { executor } = await createExecutor(loadEnv(base));
    expect(executor).toBeInstanceOf(DryRunExecutor);
    const result = await executor.execute(
      { id: 'scale_deployment', params: { deployment: 'saas-api', replicasDelta: 1, maxReplicas: 10 }, reversible: true },
      { incidentId: 'inc-1', service: 'saas-multitenant', authorizedBy: 'copilot' },
    );
    expect(result.status).toBe('dry_run');
    expect(result.detail).toMatch(/^\[dry-run\] scale_deployment/);
  });

  it('modo live exige allowlist de alvos e ao menos um backend, sem padrões implícitos', () => {
    expect(() => loadEnv({ ...base, EXECUTION_MODE: 'live' })).toThrow(/EXECUTOR_TARGETS_FILE/);
    expect(() => loadEnv({ ...base, EXECUTION_MODE: 'live', EXECUTOR_TARGETS_FILE: 'x.yaml' })).toThrow(/ao menos um backend/);
    expect(() => loadEnv({ ...base, EXECUTION_MODE: 'live', EXECUTOR_TARGETS_FILE: 'x.yaml', KUBE_AUTH: 'kubeconfig' })).toThrow(/KUBE_CONTEXT/);
    expect(loadEnv({ ...base, EXECUTION_MODE: 'live', EXECUTOR_TARGETS_FILE: 'x.yaml', KUBE_AUTH: 'in-cluster' }).EXECUTION_MODE).toBe('live');
  });
});
