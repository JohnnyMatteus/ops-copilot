import { describe, expect, it } from 'vitest';
import { AlertmanagerWebhookSchema, firingAlerts, InvalidAlertError } from '../../src/domain/alert.js';
import { firing, webhookPayload } from '../helpers/alertmanager.js';

describe('webhook do Alertmanager', () => {
  it('normaliza alertas disparados e ignora os resolvidos', () => {
    const payload = AlertmanagerWebhookSchema.parse(
      webhookPayload([
        firing({ alertname: 'SaasP99LatencyHigh', service: 'saas-multitenant', severity: 'critical' }),
        { ...firing({ alertname: 'SaasP99LatencyHigh', service: 'saas-multitenant' }, 'def456'), status: 'resolved' },
      ]),
    );
    const alerts = firingAlerts(payload);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ alertname: 'SaasP99LatencyHigh', service: 'saas-multitenant', severity: 'critical' });
  });

  it('alerta disparado sem rótulo service é erro explícito', () => {
    const payload = AlertmanagerWebhookSchema.parse(webhookPayload([firing({ alertname: 'X' })]));
    expect(() => firingAlerts(payload)).toThrow(InvalidAlertError);
  });

  it('rejeita versão de payload desconhecida', () => {
    expect(AlertmanagerWebhookSchema.safeParse({ ...webhookPayload([firing({})]), version: '3' }).success).toBe(false);
  });
});
