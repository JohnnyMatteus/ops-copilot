#!/bin/sh
# Envia um alerta de exemplo no formato do Alertmanager para o copiloto (make seed).
# Uso: scripts/seed-alert.sh [saas|payments|telemetry]
set -eu

TARGET="${COPILOT_URL:-http://localhost:${COPILOT_PORT:-8080}}"
TOKEN="${WEBHOOK_TOKEN:-dev-only-webhook-token-change-me}"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

case "${1:-saas}" in
  saas) LABELS='"alertname":"SaasP99LatencyHigh","service":"saas-multitenant","severity":"critical"' ;;
  payments) LABELS='"alertname":"PaymentsDlqBacklogHigh","service":"payments-events-go","severity":"critical"' ;;
  telemetry) LABELS='"alertname":"TelemetryConsumerLagHigh","service":"kafka-telemetry","consumergroup":"greenhouse-readings-enricher","severity":"warning"' ;;
  *) echo "uso: $0 [saas|payments|telemetry]" >&2; exit 2 ;;
esac

curl -fsS -X POST "$TARGET/webhooks/alertmanager" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"version\":\"4\",\"groupKey\":\"seed\",\"status\":\"firing\",\"receiver\":\"ops-copilot\",\"alerts\":[{\"status\":\"firing\",\"labels\":{$LABELS},\"annotations\":{\"summary\":\"alerta de exemplo (make seed)\"},\"startsAt\":\"$NOW\",\"fingerprint\":\"seed-$NOW\"}]}"
echo
