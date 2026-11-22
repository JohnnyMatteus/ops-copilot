<script setup lang="ts">
import { mdiArrowLeft, mdiOpenInNew } from '@mdi/js';
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useConfig, useIncident, usePlaybooks } from '@/api/queries';
import type { Signal } from '@/api/schemas';
import CheckLines from '@/components/signature/CheckLines.vue';
import DeadlineClock from '@/components/signature/DeadlineClock.vue';
import GateTape from '@/components/signature/GateTape.vue';
import Sparkline from '@/components/signature/Sparkline.vue';
import VerdictStamp from '@/components/signature/VerdictStamp.vue';
import DecisionPanel from '@/components/DecisionPanel.vue';
import RollbackPanel from '@/components/RollbackPanel.vue';
import { ApiError } from '@/api/client';
import { useClock } from '@/composables/useClock';
import { dateTime, duration, percent } from '@/domain/format';
import { STATUS_LABEL, statusOf } from '@/domain/status';
import { LEVEL_LABEL, VERDICT_LONG } from '@/domain/verdict';

const route = useRoute();
const id = computed(() => String(route.params['id']));
const incident = useIncident(id);
const playbooks = usePlaybooks();
const config = useConfig();
const clock = useClock();

const data = computed(() => incident.data.value);
const status = computed(() => (data.value ? statusOf(data.value, clock.value) : null));
const playbook = computed(() => playbooks.data.value?.playbooks.find((p) => p.metadata.id === data.value?.playbookId));
const hypothesis = computed(() => playbook.value?.diagnosis.hypotheses.find((h) => h.id === data.value?.diagnosis?.hypothesisId));

const evidence = computed(() => {
  const observations = new Map<string, string[]>();
  for (const item of data.value?.diagnosis?.evidence ?? []) observations.set(item.signal, [...(observations.get(item.signal) ?? []), item.observation]);
  return (data.value?.signals ?? []).map((signal) => ({ signal, observations: observations.get(signal.name) ?? [] }));
});

const traceLink = computed(() => {
  const base = config.data.value?.jaegerUrl;
  if (!base || !data.value) return null;
  const tags = encodeURIComponent(JSON.stringify({ 'ops_copilot.incident_id': data.value.incidentId }));
  return `${base}/search?service=ops-copilot&tags=${tags}`;
});

const undo = computed(() => {
  const execution = data.value?.execution ?? data.value?.resolution?.execution;
  return execution?.status === 'executed' && execution.undo ? execution.undo : null;
});

const notFound = computed(() => incident.error.value instanceof ApiError && incident.error.value.status === 404);

function describe(signal: Signal): string {
  if (signal.kind === 'metric') return `${String(signal.series.length)} série(s)`;
  if (signal.kind === 'trace') return `${String(signal.traces.length)} trace(s) em ${signal.service}`;
  return `fonte ${signal.source} fora do ar`;
}
</script>

<template>
  <div class="page">
    <v-btn to="/" variant="text" size="small" class="mb-2"><v-icon :icon="mdiArrowLeft" size="16" start />Incidentes</v-btn>

    <v-alert v-if="notFound" type="error" role="alert">Incidente não encontrado. Ele pode ter saído da retenção de 7 dias.</v-alert>
    <v-alert v-else-if="incident.isError.value" type="error" role="alert">Não foi possível carregar o incidente.</v-alert>
    <p v-else-if="incident.isPending.value" class="medium">Carregando a investigação…</p>

    <template v-if="data && status">
      <div class="d-flex flex-wrap align-center mb-3" style="gap: 12px">
        <h1 class="page-title mb-0 mono" style="font-size: 16px">{{ data.alertname }}</h1>
        <span class="mono">{{ data.service }}</span>
        <v-chip class="mono">{{ data.severity }}</v-chip>
        <span class="label medium">{{ STATUS_LABEL[status] }}</span>
        <DeadlineClock v-if="status === 'awaiting' && data.approvalExpiresAt" :expires-at="data.approvalExpiresAt" />
        <v-spacer />
        <span class="mono medium">{{ dateTime(data.startedAt) }} · {{ duration(Date.parse(data.finishedAt) - Date.parse(data.startedAt)) }}</span>
        <v-btn v-if="traceLink" :href="traceLink" target="_blank" rel="noopener" variant="text" size="small">
          Trace no Jaeger<v-icon :icon="mdiOpenInNew" size="14" end />
        </v-btn>
      </div>
      <p v-if="data.alertSummary" class="medium mt-0">{{ data.alertSummary }}</p>

      <div class="grid">
        <section class="panel tape-col" aria-labelledby="tape-title">
          <h2 id="tape-title" class="label panel-title mt-0 mb-0">Fita do gate</h2>
          <div class="panel-body"><GateTape :incident="data" /></div>
        </section>

        <section class="panel center" aria-labelledby="diag-title">
          <h2 id="diag-title" class="label panel-title mt-0 mb-0">Diagnóstico e evidências</h2>
          <div class="panel-body">
            <template v-if="data.diagnosis">
              <p class="mt-0 mb-1">
                Hipótese <code class="mono">{{ data.diagnosis.hypothesisId }}</code> · confiança declarada
                <strong class="mono">{{ percent(data.diagnosis.confidence) }}</strong>
              </p>
              <p v-if="hypothesis" class="medium mt-0 mb-2">{{ hypothesis.description }}</p>
              <p class="mt-0">{{ data.diagnosis.summary }}</p>
              <p v-if="playbook" class="mono medium" style="font-size: 12px">
                playbook {{ playbook.metadata.id }}@{{ playbook.metadata.version }} · dono {{ playbook.metadata.owner }}
              </p>
            </template>
            <v-alert v-else type="warning" class="mb-3">{{ data.failure ?? 'Esta investigação terminou sem diagnóstico.' }}</v-alert>

            <h3 class="label mb-2 mt-4">Evidências ({{ evidence.length }})</h3>
            <p v-if="evidence.length === 0" class="medium">Nenhum sinal foi coletado.</p>
            <ul class="evidence">
              <li v-for="{ signal, observations } in evidence" :key="signal.name" :class="{ failed: signal.kind === 'error' }">
                <div class="d-flex flex-wrap align-center" style="gap: 8px">
                  <span class="label">{{ signal.kind === 'error' ? 'ERRO' : signal.kind }}</span>
                  <strong class="mono">{{ signal.name }}</strong>
                  <span class="medium">{{ describe(signal) }}</span>
                </div>
                <code v-if="signal.kind === 'metric'" class="mono query">{{ signal.query }}</code>
                <p v-if="signal.kind === 'error'" class="mono mt-1 mb-0 err">{{ signal.message }}</p>
                <div v-if="signal.kind === 'metric'" class="d-flex flex-wrap" style="gap: 12px">
                  <div v-for="(series, index) in signal.series.slice(0, 3)" :key="index">
                    <Sparkline :points="series.points" :label="`${signal.name} ${Object.values(series.labels).join(' ')}`" />
                    <div class="mono medium" style="font-size: 12px">
                      {{ Object.values(series.labels).join(' ') || 'total' }}: {{ series.points.at(-1)?.v ?? '—' }}
                    </div>
                  </div>
                </div>
                <ul v-if="signal.kind === 'trace'" class="mono traces">
                  <li v-for="trace in signal.traces.slice(0, 3)" :key="trace.traceId">
                    {{ trace.traceId.slice(0, 8) }} · {{ trace.rootOperation }} · {{ duration(trace.durationMs) }} · {{ trace.errorSpans }} span(s) com erro · mais lento:
                    {{ trace.slowestOperation.name }} ({{ duration(trace.slowestOperation.durationMs) }})
                  </li>
                </ul>
                <p v-for="text in observations" :key="text" class="observation">“{{ text }}”</p>
              </li>
            </ul>
          </div>
        </section>

        <section class="panel action-col" aria-labelledby="action-title">
          <h2 id="action-title" class="label panel-title mt-0 mb-0">Ação proposta e decisão</h2>
          <div class="panel-body">
            <template v-if="data.diagnosis?.proposedAction">
              <p class="mt-0 mb-1"><code class="mono">{{ data.diagnosis.proposedAction.actionId }}</code></p>
              <p class="medium mt-0">{{ data.diagnosis.proposedAction.rationale }}</p>
              <dl class="mono params">
                <template v-for="(value, key) in data.decision?.action?.params ?? data.diagnosis.proposedAction.params" :key="key">
                  <dt>{{ key }}</dt>
                  <dd>{{ typeof value === 'string' ? value : JSON.stringify(value) }}</dd>
                </template>
              </dl>
              <p v-if="data.decision?.action" class="mb-1">
                {{ data.decision.action.reversible ? 'Reversível: existe ação inversa.' : 'Irreversível: não há como desfazer.' }}
              </p>
            </template>
            <p v-else class="medium mt-0">O diagnóstico não propôs ação.</p>

            <template v-if="data.decision">
              <div class="d-flex align-center mt-3" style="gap: 8px">
                <VerdictStamp :verdict="data.decision.verdict" />
                <span v-if="data.decision.effectiveLevel" class="medium">nível efetivo: {{ LEVEL_LABEL[data.decision.effectiveLevel] }}</span>
              </div>
              <p class="mt-1 mb-0 medium">{{ VERDICT_LONG[data.decision.verdict] }}.</p>
              <CheckLines :checks="data.decision.checks" />
            </template>

            <div class="mt-4">
              <template v-if="status === 'awaiting' && data.approvalId">
                <h3 class="label mb-2">Decisão</h3>
                <DecisionPanel
                  :approval-id="data.approvalId"
                  :incident-id="data.incidentId"
                  :service="data.service"
                  :action="data.decision?.action?.id ?? data.diagnosis?.proposedAction?.actionId ?? ''"
                />
              </template>
              <template v-else-if="status === 'expired'">
                <v-alert type="warning" role="status">O prazo venceu sem decisão: o pedido expirou e a ação não rodou. O incidente fica registrado; um novo alerta abre outra investigação.</v-alert>
              </template>
              <template v-else-if="data.resolution">
                <h3 class="label mb-1">Decisão humana</h3>
                <p class="mt-0 mb-1">
                  <strong>{{ data.resolution.by }}</strong>
                  {{ { approved: 'aprovou', rejected: 'recusou', cancelled: 'cancelou o incidente', blocked: 'aprovou, mas o gate bloqueou na reavaliação' }[data.resolution.kind] }}
                  em {{ dateTime(data.resolution.at) }}.
                </p>
                <p v-if="data.resolution.reason" class="mt-0">Motivo: {{ data.resolution.reason }}</p>
              </template>
            </div>

            <div v-if="data.rollback" class="mt-4">
              <h3 class="label mb-1">Rollback</h3>
              <p class="mt-0 mb-1">
                <strong>{{ data.rollback.by }}</strong> reverteu em {{ dateTime(data.rollback.at) }}: {{ data.rollback.execution.detail }}
              </p>
              <p class="mt-0">Motivo: {{ data.rollback.reason }}</p>
            </div>
            <div v-else-if="undo" class="mt-4">
              <h3 class="label mb-2">Rollback</h3>
              <RollbackPanel :incident-id="data.incidentId" :undo-action="undo.actionId" :summary="(data.execution ?? data.resolution?.execution)?.detail ?? ''" />
            </div>
          </div>
        </section>
      </div>

      <p class="mt-3">
        <router-link :to="{ name: 'audit', query: { incident: data.incidentId } }">Ver a trilha de auditoria deste incidente</router-link>
      </p>
    </template>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: 360px minmax(0, 1fr) 320px;
  gap: 12px;
  align-items: start;
}
@media (max-width: 1200px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
.evidence {
  list-style: none;
  padding: 0;
  margin: 0;
}
.evidence > li {
  padding: 8px 0;
  border-bottom: 1px solid var(--hairline);
}
.evidence > li.failed {
  border-left: 2px solid rgb(var(--v-theme-verdict-blocked));
  padding-left: 8px;
}
.query {
  display: block;
  margin: 4px 0;
  padding: 4px 8px;
  background: rgb(var(--v-theme-surface-variant));
  border-radius: 2px;
  overflow-x: auto;
  white-space: pre;
}
.err {
  color: rgb(var(--v-theme-verdict-blocked));
}
.traces {
  list-style: none;
  padding: 0;
  margin: 4px 0 0;
  font-size: 12px;
}
.observation {
  margin: 4px 0 0;
}
.params {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 12px;
  margin: 8px 0;
  font-size: 12px;
}
.params dt {
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.params dd {
  margin: 0;
}
</style>
