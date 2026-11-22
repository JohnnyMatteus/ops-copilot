// Executor real (ADR 0014). Só recebe ações que o gate aprovou, mas ainda confere o alvo contra a
// allowlist determinística: o gate decide "pode agir", a allowlist decide "onde".
import type { ApprovedAction } from '../autonomy/gate.js';
import type { ActionExecutor, ExecutionContext, ExecutionResult } from './executor.js';
import type { DlqPort, FeatureFlagPort, KubernetesPort, NotifierPort } from './ports.js';
import type { TargetAllowlist } from './targets.js';

export interface LiveBackends {
  readonly kubernetes?: KubernetesPort | undefined;
  readonly featureFlags?: FeatureFlagPort | undefined;
  readonly dlq?: DlqPort | undefined;
  readonly notifier?: NotifierPort | undefined;
}

export class LiveExecutor implements ActionExecutor {
  readonly mode = 'live' as const;
  readonly #allowlist: TargetAllowlist;
  readonly #backends: LiveBackends;
  readonly #now: () => Date;

  constructor(allowlist: TargetAllowlist, backends: LiveBackends, now: () => Date = () => new Date()) {
    this.#allowlist = allowlist;
    this.#backends = backends;
    this.#now = now;
  }

  async execute(action: ApprovedAction, context: ExecutionContext): Promise<ExecutionResult> {
    const refuse = (detail: string): ExecutionResult => ({ status: 'failed', actionId: action.id, detail });
    const done = (detail: string, undo?: ExecutionResult['undo']): ExecutionResult => ({
      status: 'executed',
      actionId: action.id,
      detail,
      undo: undo ?? null,
    });
    const { service } = context;
    const params = action.params;
    const text = (key: string) => String(params[key]);
    const num = (key: string) => Number(params[key]);

    switch (action.id) {
      case 'scale_deployment':
      case 'restore_deployment_replicas': {
        const target = this.#allowlist.kubernetes(service, text('deployment'));
        if (!target) return refuse(`Alvo fora da allowlist: deployment ${text('deployment')} de ${service}.`);
        const kube = this.#backends.kubernetes;
        if (!kube) return refuse('Backend Kubernetes não configurado.');
        const current = await kube.replicas(target.namespace, target.deployment);
        const where = `${target.namespace}/${target.deployment}`;
        if (action.id === 'restore_deployment_replicas') {
          await kube.setReplicas(target.namespace, target.deployment, current, num('replicas'));
          return done(`${where}: ${String(current)} → ${String(num('replicas'))} réplicas (restauração).`);
        }
        const next = Math.min(current + num('replicasDelta'), num('maxReplicas'));
        if (next <= current) return done(`${where}: já em ${String(current)} réplicas, no teto ${String(num('maxReplicas'))}; nada a fazer.`);
        await kube.setReplicas(target.namespace, target.deployment, current, next);
        return done(`${where}: ${String(current)} → ${String(next)} réplicas.`, {
          actionId: 'restore_deployment_replicas',
          params: { deployment: target.deployment, replicas: current },
        });
      }
      case 'restart_pods': {
        const target = this.#allowlist.kubernetes(service, text('deployment'));
        if (!target) return refuse(`Alvo fora da allowlist: deployment ${text('deployment')} de ${service}.`);
        if (!this.#backends.kubernetes) return refuse('Backend Kubernetes não configurado.');
        await this.#backends.kubernetes.restart(target.namespace, target.deployment, this.#now());
        return done(`${target.namespace}/${target.deployment}: rollout restart solicitado.`);
      }
      case 'toggle_feature_flag':
      case 'restore_feature_flag': {
        const flag = text('flag');
        if (!this.#allowlist.featureFlag(service, flag)) return refuse(`Alvo fora da allowlist: flag ${flag} de ${service}.`);
        const flags = this.#backends.featureFlags;
        if (!flags) return refuse('Backend de feature flags não configurado.');
        const enabled = params['enabled'] === true;
        const before = await flags.isEnabled(flag);
        if (before === enabled) return done(`Flag ${flag} já estava ${enabled ? 'ligada' : 'desligada'}; nada a fazer.`);
        await flags.set(flag, enabled);
        const undo = action.id === 'toggle_feature_flag' && before ? { actionId: 'restore_feature_flag', params: { flag, enabled: true } } : null;
        return done(`Flag ${flag}: ${before ? 'ligada' : 'desligada'} → ${enabled ? 'ligada' : 'desligada'}.`, undo);
      }
      case 'replay_dlq_batch': {
        const route = this.#allowlist.dlqRoute(service, text('queue'));
        if (!route) return refuse(`Alvo fora da allowlist: fila ${text('queue')} de ${service}.`);
        if (!this.#backends.dlq) return refuse('Backend de DLQ não configurado.');
        const moved = await this.#backends.dlq.replay(text('queue'), route, num('maxMessages'));
        return done(`${String(moved)} mensagem(ns) de ${text('queue')} reenviadas para ${route}.`);
      }
      case 'notify_oncall': {
        if (!this.#backends.notifier) return refuse('Notificador não configurado.');
        await this.#backends.notifier.notify(
          text('channel'),
          `Incidente ${context.incidentId} em ${service}: o copiloto pede atenção do plantão (autorizado por ${context.authorizedBy}).`,
        );
        return done(`Plantão avisado em ${text('channel')}.`);
      }
      default:
        return refuse(`Ação ${action.id} não tem executor real.`);
    }
  }
}
