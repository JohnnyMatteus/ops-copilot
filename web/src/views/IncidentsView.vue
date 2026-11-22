<script setup lang="ts">
import { onKeyStroke } from '@vueuse/core';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useIncidents } from '@/api/queries';
import type { Incident } from '@/api/schemas';
import DeadlineClock from '@/components/signature/DeadlineClock.vue';
import VerdictStamp from '@/components/signature/VerdictStamp.vue';
import ServiceStrip from '@/components/ServiceStrip.vue';
import { useClock } from '@/composables/useClock';
import { ago } from '@/domain/format';
import { currentStep, isOpen, STATUS_LABEL, statusOf, verdictOf } from '@/domain/status';

const router = useRouter();
const incidents = useIncidents();
const now = useClock();

// Aprovações pendentes sobem para o topo; o resto segue do mais recente para o mais antigo.
const rows = computed(() => {
  const list = (incidents.data.value ?? []).map((incident) => ({ incident, status: statusOf(incident, now.value) }));
  return [...list.filter((row) => isOpen(row.status)), ...list.filter((row) => !isOpen(row.status))];
});
const cursor = ref(0);
const selected = computed<Incident | undefined>(() => rows.value[cursor.value]?.incident);

const typing = (event: KeyboardEvent) => ['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement).tagName) || event.metaKey || event.ctrlKey;
onKeyStroke('j', (event) => !typing(event) && (cursor.value = Math.min(cursor.value + 1, rows.value.length - 1)));
onKeyStroke('k', (event) => !typing(event) && (cursor.value = Math.max(cursor.value - 1, 0)));
onKeyStroke(['Enter', 'a'], (event) => {
  if (typing(event) || !selected.value) return;
  if (event.key === 'a' && !isOpen(rows.value[cursor.value]?.status ?? 'blocked')) return;
  void router.push(`/incidents/${selected.value.incidentId}`);
});

const latest = computed(() => incidents.data.value?.[0]);
</script>

<template>
  <div class="page">
    <h1 class="page-title">Incidentes</h1>
    <ServiceStrip :incidents="incidents.data.value ?? []" :now="now" />

    <v-alert v-if="incidents.isError.value" type="error" role="alert" class="mb-3">Não foi possível carregar os incidentes. O copiloto está no ar?</v-alert>

    <div class="panel">
      <div class="head row label medium" role="row">
        <span>alerta</span><span>serviço</span><span>etapa</span><span>veredicto</span><span>estado</span><span class="end">há</span>
      </div>
      <div v-if="incidents.isPending.value" class="panel-body medium">Carregando incidentes…</div>
      <div v-else-if="rows.length === 0" class="panel-body">
        Nenhum incidente aberto. Dispare um alerta com <code class="mono">make seed</code> e a investigação aparece aqui.
      </div>
      <router-link
        v-for="(row, index) in rows"
        :key="row.incident.incidentId"
        :to="`/incidents/${row.incident.incidentId}`"
        class="row row-link"
        :class="{ 'is-active': index === cursor, 'is-pending': isOpen(row.status) }"
        @mouseenter="cursor = index"
      >
        <span class="mono">{{ row.incident.alertname }}</span>
        <span class="mono">{{ row.incident.service }}</span>
        <span class="label medium">{{ currentStep(row.incident) }}</span>
        <span><VerdictStamp v-if="verdictOf(row.incident)" :verdict="verdictOf(row.incident)!" /><span v-else class="medium">—</span></span>
        <span>
          <DeadlineClock v-if="row.status === 'awaiting' && row.incident.approvalExpiresAt" :expires-at="row.incident.approvalExpiresAt" />
          <span v-else>{{ STATUS_LABEL[row.status] }}</span>
        </span>
        <span class="mono medium end">{{ ago(row.incident.startedAt) }}</span>
      </router-link>
    </div>
    <p v-if="latest && rows.length > 0" class="medium mt-3" style="font-size: 12px">
      <kbd class="mono">j</kbd>/<kbd class="mono">k</kbd> navega, <kbd class="mono">enter</kbd> abre, <kbd class="mono">a</kbd> abre o incidente para decidir,
      <kbd class="mono">⌘K</kbd> paleta de comandos.
    </p>
  </div>
</template>

<style scoped>
.row {
  grid-template-columns: minmax(160px, 1.4fr) minmax(140px, 1fr) 90px 130px minmax(150px, 1fr) 90px;
  font-size: 13px;
}
.head {
  display: grid;
  align-items: center;
  min-height: 28px;
  padding: 0 12px;
  gap: 12px;
  border-bottom: 1px solid var(--hairline);
}
.end {
  text-align: right;
}
@media (max-width: 800px) {
  .row,
  .head {
    grid-template-columns: 1fr 1fr;
    padding-block: 6px;
  }
  .head {
    display: none;
  }
}
</style>
