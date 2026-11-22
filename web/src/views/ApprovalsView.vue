<script setup lang="ts">
import { computed } from 'vue';
import { useApprovals } from '@/api/queries';
import DecisionPanel from '@/components/DecisionPanel.vue';
import CheckLines from '@/components/signature/CheckLines.vue';
import DeadlineClock from '@/components/signature/DeadlineClock.vue';
import { requiresServiceConfirmation } from '@/domain/approval';
import { dateTime, percent } from '@/domain/format';

const approvals = useApprovals();
// Prazo mais curto primeiro: é o que vence antes.
const rows = computed(() => [...(approvals.data.value ?? [])].sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt)));
</script>

<template>
  <div class="page">
    <h1 class="page-title">Fila de aprovações</h1>
    <v-alert v-if="approvals.isError.value" type="error" role="alert" class="mb-3">Não foi possível carregar a fila.</v-alert>
    <div v-if="approvals.isPending.value" class="medium">Carregando a fila…</div>
    <div v-else-if="rows.length === 0" class="panel panel-body">Nada aguardando decisão. Quando o gate pedir aprovação, o pedido aparece aqui com o prazo.</div>

    <article v-for="approval in rows" :key="approval.id" class="panel mb-3" :aria-label="`Aprovação de ${approval.action} em ${approval.service}`">
      <header class="panel-title d-flex flex-wrap align-center" style="gap: 12px; background: rgba(var(--v-theme-primary), 0.1)">
        <strong class="mono">{{ approval.action }}</strong>
        <span class="mono">{{ approval.service }}</span>
        <router-link :to="`/incidents/${approval.incidentId}`" class="mono">{{ approval.alertname ?? 'incidente' }}</router-link>
        <v-spacer />
        <DeadlineClock :expires-at="approval.expiresAt" />
      </header>
      <div class="panel-body body">
        <div>
          <h3 class="label mt-0 mb-1">Por que precisa de humano</h3>
          <ul class="mt-0 pl-4">
            <li v-for="reason in approval.reasons" :key="reason">{{ reason }}</li>
          </ul>
          <CheckLines :checks="approval.checks" />
          <h3 class="label mt-3 mb-1">Se o prazo vencer</h3>
          <p class="mt-0 medium">
            O pedido expira às {{ dateTime(approval.expiresAt) }} e a ação não roda. Nada executa por omissão; o incidente continua registrado.
          </p>
        </div>
        <div>
          <h3 class="label mt-0 mb-1">Parâmetros</h3>
          <dl class="mono params">
            <template v-for="(value, key) in approval.params" :key="key">
              <dt>{{ key }}</dt>
              <dd>{{ typeof value === 'string' ? value : JSON.stringify(value) }}</dd>
            </template>
          </dl>
          <p class="mb-1">
            Hipótese <code class="mono">{{ approval.hypothesisId }}</code> · confiança <span class="mono">{{ percent(approval.confidence) }}</span>
          </p>
          <p class="mt-0 mb-0">{{ approval.reversible === false ? 'Irreversível.' : approval.reversible ? 'Reversível.' : '' }}</p>
          <p v-if="requiresServiceConfirmation(approval.service, approval.action)" class="medium mt-1" style="font-size: 12px">
            Mexe com dinheiro: aprovar exige digitar o nome do serviço.
          </p>
        </div>
        <div class="decide">
          <DecisionPanel :approval-id="approval.id" :incident-id="approval.incidentId" :service="approval.service" :action="approval.action" />
        </div>
      </div>
    </article>
  </div>
</template>

<style scoped>
.body {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: 24px;
}
@media (max-width: 1000px) {
  .body {
    grid-template-columns: 1fr;
  }
}
.params {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 12px;
  margin: 0 0 8px;
  font-size: 12px;
}
.params dd {
  margin: 0;
}
</style>
