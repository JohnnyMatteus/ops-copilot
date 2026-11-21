// Payload do webhook do Alertmanager (versão 4) e o alerta normalizado que entra no grafo.
import { z } from 'zod';

const LabelSetSchema = z.record(z.string(), z.string());

export const AlertmanagerAlertSchema = z.object({
  status: z.enum(['firing', 'resolved']),
  labels: LabelSetSchema,
  annotations: LabelSetSchema.default({}),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.string().optional(),
  generatorURL: z.string().optional(),
  fingerprint: z.string().min(1),
});

export const AlertmanagerWebhookSchema = z.object({
  version: z.literal('4'),
  groupKey: z.string(),
  status: z.enum(['firing', 'resolved']),
  receiver: z.string(),
  groupLabels: LabelSetSchema.default({}),
  commonLabels: LabelSetSchema.default({}),
  commonAnnotations: LabelSetSchema.default({}),
  externalURL: z.string().optional(),
  truncatedAlerts: z.number().int().nonnegative().optional(),
  alerts: z.array(AlertmanagerAlertSchema).min(1),
});
export type AlertmanagerWebhook = z.infer<typeof AlertmanagerWebhookSchema>;

/** Alerta que o copiloto investiga. `alertname` e `service` são obrigatórios: sem eles não há playbook. */
export const AlertSchema = z.object({
  fingerprint: z.string().min(1),
  alertname: z.string().min(1),
  service: z.string().min(1),
  severity: z.string().default('unknown'),
  startsAt: z.iso.datetime({ offset: true }),
  labels: LabelSetSchema,
  annotations: LabelSetSchema,
});
export type Alert = z.infer<typeof AlertSchema>;

export class InvalidAlertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAlertError';
  }
}

/**
 * Converte o payload em alertas investigáveis. Alertas `resolved` não abrem incidente;
 * um alerta `firing` sem `alertname` ou `service` é erro explícito, não descarte silencioso.
 */
export function firingAlerts(payload: AlertmanagerWebhook): Alert[] {
  return payload.alerts
    .filter((alert) => alert.status === 'firing')
    .map((alert) => {
      const { alertname, service, severity } = alert.labels;
      if (!alertname || !service) {
        throw new InvalidAlertError(
          `Alerta ${alert.fingerprint} sem os rótulos obrigatórios "alertname" e "service".`,
        );
      }
      return AlertSchema.parse({
        fingerprint: alert.fingerprint,
        alertname,
        service,
        severity: severity ?? 'unknown',
        startsAt: alert.startsAt,
        labels: alert.labels,
        annotations: alert.annotations,
      });
    });
}
