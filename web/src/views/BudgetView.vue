<script setup lang="ts">
import { computed } from 'vue';
import { useBudget } from '@/api/queries';
import { number } from '@/domain/format';
import { LEVEL_LABEL } from '@/domain/verdict';

const budget = useBudget();
const data = computed(() => budget.data.value);

const windowLabel = (ms: number) => (ms % 3_600_000 === 0 ? `${String(ms / 3_600_000)} h` : `${String(Math.round(ms / 60_000))} min`);
const slots = (max: number, remaining: number | null) =>
  Array.from({ length: max }, (_, index) => ({ free: remaining !== null && index < remaining }));
</script>

<template>
  <div class="page">
    <h1 class="page-title">Orçamento de ações automáticas</h1>
    <v-alert v-if="budget.isError.value" type="error" role="alert">Não foi possível carregar o orçamento.</v-alert>
    <p v-else-if="budget.isPending.value" class="medium">Carregando o orçamento…</p>

    <template v-if="data">
      <p class="mt-0">
        Cada serviço tem um número máximo de ações automáticas por janela. Esgotado o orçamento, a ação passa a exigir aprovação humana.
        Se o Redis não responde, o saldo é tratado como indisponível e nada executa sozinho.
      </p>
      <v-alert v-if="data.killSwitch" type="error" class="mb-3" role="status">Kill switch ligado: o orçamento não é consumido, nada executa.</v-alert>

      <div class="panel mb-4">
        <h2 class="label panel-title mt-0 mb-0">Saldo por serviço</h2>
        <div v-for="service in data.services" :key="service.name" class="line hairline-b">
          <div>
            <strong class="mono">{{ service.name }}</strong>
            <div class="medium">{{ LEVEL_LABEL[service.level] }}</div>
          </div>
          <div v-if="service.maxAutoActions === 0" class="medium">Sem ações automáticas: este serviço sempre passa por uma pessoa.</div>
          <div v-else class="d-flex align-center" style="gap: 12px">
            <span class="slots" role="img" :aria-label="`${service.remaining ?? 'saldo indisponível'} de ${service.maxAutoActions} ações livres`">
              <i v-for="(slot, index) in slots(service.maxAutoActions, service.remaining)" :key="index" :class="{ free: slot.free }" />
            </span>
            <span class="mono tabular">
              {{ service.remaining === null ? 'indisponível' : `${service.remaining} de ${service.maxAutoActions} livres` }} · janela de {{ windowLabel(service.windowMs) }}
            </span>
          </div>
          <div v-if="service.maxAutoActions > 0 && service.remaining === 0" class="mono" style="color: rgb(var(--v-theme-primary))">
            esgotado: próximas ações pedem aprovação
          </div>
        </div>
      </div>

      <div class="panel">
        <h2 class="label panel-title mt-0 mb-0">Consumo do LLM nos últimos {{ data.llm.incidents }} incidentes</h2>
        <div class="panel-body mono tabular">
          {{ number(data.llm.inputTokens) }} tokens de entrada · {{ number(data.llm.outputTokens) }} de saída ·
          {{ data.llm.costUsd === null ? 'custo não informado pelo provedor' : `US$ ${data.llm.costUsd.toFixed(4).replace('.', ',')}` }}
        </div>
        <p class="panel-body medium mt-0 mb-0 hairline-b" style="font-size: 12px; border-bottom: 0">
          O gate não depende do LLM para decidir: este consumo é só informativo. O teto de custo por incidente é uma evolução (Próximos passos).
        </p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.line {
  display: grid;
  grid-template-columns: 240px 1fr auto;
  gap: 16px;
  align-items: center;
  padding: 10px 12px;
}
@media (max-width: 800px) {
  .line {
    grid-template-columns: 1fr;
  }
}
.slots {
  display: inline-flex;
  gap: 3px;
}
.slots i {
  width: 14px;
  height: 14px;
  border: 1px solid var(--hairline);
  display: block;
}
.slots i.free {
  background: rgb(var(--v-theme-verdict-auto));
  border-color: rgb(var(--v-theme-verdict-auto));
}
</style>
