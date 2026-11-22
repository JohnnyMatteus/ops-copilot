// Factory do executor: dry-run é o padrão; live monta os adaptadores só a partir de configuração
// explícita e nunca degrada em silêncio para dry-run.
import { Redis } from 'ioredis';
import type { Env } from '../config/env.js';
import { DryRunExecutor, ExecutorConfigError, type ActionExecutor } from './executor.js';
import { RedisDlqReplayer } from './dlq-redis.js';
import { HttpFeatureFlagClient } from './feature-flags.js';
import { KubernetesAdapter, loadKubeConfig } from './kubernetes.js';
import { LiveExecutor, type LiveBackends } from './live.js';
import { loadExecutorTargets } from './targets.js';

export interface ExecutorHandle {
  readonly executor: ActionExecutor;
  close(): Promise<void>;
}

export async function createExecutor(env: Env, extra: Pick<LiveBackends, 'notifier'> = {}): Promise<ExecutorHandle> {
  if (env.EXECUTION_MODE === 'dry-run') return { executor: new DryRunExecutor(), close: async () => undefined };
  if (!env.EXECUTOR_TARGETS_FILE) throw new ExecutorConfigError('EXECUTION_MODE=live exige EXECUTOR_TARGETS_FILE.');

  const allowlist = await loadExecutorTargets(env.EXECUTOR_TARGETS_FILE);
  let dlqRedis: Redis | undefined;
  const kubeAuth =
    env.KUBE_AUTH === 'in-cluster'
      ? ({ kind: 'in-cluster' } as const)
      : env.KUBE_AUTH === 'kubeconfig' && env.KUBECONFIG_PATH && env.KUBE_CONTEXT
        ? ({ kind: 'kubeconfig', path: env.KUBECONFIG_PATH, context: env.KUBE_CONTEXT } as const)
        : null;
  if (env.DLQ_REDIS_URL) dlqRedis = new Redis(env.DLQ_REDIS_URL, { maxRetriesPerRequest: 1 });

  const executor = new LiveExecutor(allowlist, {
    kubernetes: kubeAuth ? new KubernetesAdapter(loadKubeConfig(kubeAuth)) : undefined,
    featureFlags:
      env.FEATURE_FLAGS_URL && env.FEATURE_FLAGS_TOKEN
        ? new HttpFeatureFlagClient({ baseUrl: env.FEATURE_FLAGS_URL, token: env.FEATURE_FLAGS_TOKEN })
        : undefined,
    dlq: dlqRedis ? new RedisDlqReplayer(dlqRedis) : undefined,
    notifier: extra.notifier,
  });
  return {
    executor,
    close: async () => {
      await dlqRedis?.quit();
    },
  };
}
