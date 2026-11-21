// Payloads no formato do webhook do Alertmanager (versão 4).
export const webhookPayload = (alerts: object[]) => ({
  version: '4',
  groupKey: '{}:{alertname="SaasP99LatencyHigh"}',
  status: 'firing',
  receiver: 'ops-copilot',
  groupLabels: { alertname: 'SaasP99LatencyHigh' },
  commonLabels: {},
  commonAnnotations: {},
  externalURL: 'http://alertmanager.example.com',
  alerts,
});

export const firing = (labels: Record<string, string>, fingerprint = 'abc123') => ({
  status: 'firing',
  labels,
  annotations: { summary: 'p99 acima de 1s' },
  startsAt: '2026-11-20T11:50:00Z',
  endsAt: '0001-01-01T00:00:00Z',
  generatorURL: 'http://prometheus.example.com/graph',
  fingerprint,
});
