// Allowlist de alvos do executor real (ADR 0014). Deny-by-default: o que não está listado aqui
// nunca é tocado, mesmo que o gate, o playbook e a política tenham aprovado a ação.
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

const k8sName = z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/, 'nome Kubernetes inválido');
const RESERVED_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease']);
const queueName = z.string().regex(/^[a-z0-9_.-]{1,128}$/);

export const ExecutorTargetsSchema = z.strictObject({
  apiVersion: z.literal('ops-copilot/v1'),
  kind: z.literal('ExecutorTargets'),
  /** Por serviço do incidente: em que namespace e em quais deployments o executor pode agir. */
  kubernetes: z
    .record(
      z.string().min(1),
      z.strictObject({
        namespace: k8sName.refine((ns) => !RESERVED_NAMESPACES.has(ns), 'namespace de sistema não pode ser alvo'),
        deployments: z.array(k8sName).min(1),
      }),
    )
    .default({}),
  featureFlags: z.record(z.string().min(1), z.array(z.string().regex(/^[a-z0-9_.-]{1,64}$/)).min(1)).default({}),
  /** Canais que `notify_oncall` pode avisar, por serviço: o canal nunca vem só do playbook. */
  notifications: z.record(z.string().min(1), z.array(z.string().regex(/^#[a-z0-9-]{1,80}$/)).min(1)).default({}),
  /** Cada DLQ declara para qual fila volta: o destino nunca vem do LLM. */
  dlq: z
    .record(
      z.string().min(1),
      z
        .array(
          z
            .strictObject({ queue: queueName, replayTo: queueName })
            .refine((route) => route.queue !== route.replayTo, 'replayTo não pode ser a própria DLQ'),
        )
        .min(1),
    )
    .default({}),
});
export type ExecutorTargets = z.infer<typeof ExecutorTargetsSchema>;

export interface KubernetesTarget {
  readonly namespace: string;
  readonly deployment: string;
}

export class TargetAllowlist {
  readonly #targets: ExecutorTargets;

  constructor(targets: ExecutorTargets) {
    this.#targets = targets;
  }

  kubernetes(service: string, deployment: string): KubernetesTarget | null {
    const entry = own(this.#targets.kubernetes, service);
    return entry?.deployments.includes(deployment) ? { namespace: entry.namespace, deployment } : null;
  }

  featureFlag(service: string, flag: string): boolean {
    return own(this.#targets.featureFlags, service)?.includes(flag) ?? false;
  }

  notificationChannel(service: string, channel: string): boolean {
    return own(this.#targets.notifications, service)?.includes(channel) ?? false;
  }

  /** Fila de destino do replay, ou `null` se a DLQ não estiver liberada para o serviço. */
  dlqRoute(service: string, queue: string): string | null {
    return own(this.#targets.dlq, service)?.find((route) => route.queue === queue)?.replayTo ?? null;
  }
}

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

export class TargetsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetsValidationError';
  }
}

export async function loadExecutorTargets(path: string): Promise<TargetAllowlist> {
  const result = ExecutorTargetsSchema.safeParse(parse(await readFile(path, 'utf8')));
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(raiz)'}: ${issue.message}`);
    throw new TargetsValidationError(`${path}: alvos do executor inválidos\n${issues.join('\n')}`);
  }
  return new TargetAllowlist(result.data);
}
