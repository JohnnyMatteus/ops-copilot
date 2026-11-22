// Adaptador Kubernetes sobre o cliente oficial (@kubernetes/client-node). Escala pelo subrecurso
// `scale` com JSON Patch precedido de `test`: se o valor mudou desde a leitura, o servidor recusa.
import { AppsV1Api, KubeConfig, PatchStrategy, setHeaderOptions } from '@kubernetes/client-node';
import type { KubernetesPort } from './ports.js';

export type KubeAuth =
  | { readonly kind: 'in-cluster' }
  /** Caminho e contexto explícitos: o adaptador nunca lê o kubeconfig padrão da máquina. */
  | { readonly kind: 'kubeconfig'; readonly path: string; readonly context: string };

export function loadKubeConfig(auth: KubeAuth): KubeConfig {
  const config = new KubeConfig();
  if (auth.kind === 'in-cluster') {
    config.loadFromCluster();
  } else {
    config.loadFromFile(auth.path);
    config.setCurrentContext(auth.context);
  }
  return config;
}

export class KubernetesAdapter implements KubernetesPort {
  readonly #apps: AppsV1Api;

  constructor(config: KubeConfig) {
    this.#apps = config.makeApiClient(AppsV1Api);
  }

  async replicas(namespace: string, deployment: string): Promise<number> {
    const scale = await this.#apps.readNamespacedDeploymentScale({ name: deployment, namespace });
    const replicas = scale.spec?.replicas;
    // Ausência não é zero: zero significa "parado de propósito" e muda o que o executor pode fazer.
    if (replicas === undefined) throw new Error(`Resposta do Kubernetes sem spec.replicas para ${namespace}/${deployment}.`);
    return replicas;
  }

  async setReplicas(namespace: string, deployment: string, from: number, to: number): Promise<void> {
    await this.#apps.patchNamespacedDeploymentScale(
      {
        name: deployment,
        namespace,
        body: [
          { op: 'test', path: '/spec/replicas', value: from },
          { op: 'replace', path: '/spec/replicas', value: to },
        ],
      },
      setHeaderOptions('Content-Type', PatchStrategy.JsonPatch),
    );
  }

  async restart(namespace: string, deployment: string, at: Date): Promise<void> {
    await this.#apps.patchNamespacedDeployment(
      {
        name: deployment,
        namespace,
        body: { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': at.toISOString() } } } } },
      },
      setHeaderOptions('Content-Type', PatchStrategy.StrategicMergePatch),
    );
  }
}
