<script setup lang="ts">
import { computed } from 'vue';
import { usePolicy } from '@/api/queries';
import { describeLimit, effectiveCell, type Cell } from '@/domain/policy';
import { LEVEL_LABEL } from '@/domain/verdict';
import { mdiCancel, mdiHandBackLeftOutline, mdiLightbulbOutline, mdiShieldCheckOutline } from '@mdi/js';

const policy = usePolicy();
const data = computed(() => policy.data.value);

// A mesma gramática do gate: o nível efetivo vira um dos quatro veredictos visuais.
const CELL: Record<Cell, { label: string; color: string; icon: string }> = {
  auto_execute: { label: 'auto', color: 'verdict-auto', icon: mdiShieldCheckOutline },
  execute_with_approval: { label: 'aprovação', color: 'verdict-approval', icon: mdiHandBackLeftOutline },
  suggest: { label: 'sugestão', color: 'verdict-suggest', icon: mdiLightbulbOutline },
  read_only: { label: 'leitura', color: 'verdict-blocked', icon: mdiCancel },
  not_allowed: { label: 'bloqueado', color: 'verdict-blocked', icon: mdiCancel },
};
</script>

<template>
  <div class="page">
    <h1 class="page-title">Limites de autonomia</h1>
    <v-alert v-if="policy.isError.value" type="error" role="alert">Não foi possível carregar a política.</v-alert>
    <p v-else-if="policy.isPending.value" class="medium">Carregando a política…</p>

    <template v-if="data">
      <p class="mt-0">
        Leitura apenas: os limites vivem em código e mudam por pull request. Origem
        <code class="mono">{{ data.source.file }}</code> no commit <code class="mono">{{ data.source.commit }}</code>.
      </p>
      <v-alert v-if="data.killSwitch" type="error" class="mb-3" role="status">Kill switch ligado: nenhuma execução, tudo vira sugestão.</v-alert>

      <div class="panel mb-4">
        <h2 class="label panel-title mt-0 mb-0">Matriz serviço × ação</h2>
        <div class="scroll">
          <table class="matrix">
            <thead>
              <tr>
                <th class="label medium">serviço (nível)</th>
                <th v-for="action in data.actions" :key="action.id" class="mono">{{ action.id }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="service in data.services" :key="service.name">
                <th scope="row" class="mono">
                  {{ service.name }}<br /><span class="medium">{{ LEVEL_LABEL[service.level] }}</span>
                </th>
                <td v-for="action in data.actions" :key="action.id">
                  <span class="cell label" :style="{ '--tone': `var(--v-theme-${CELL[effectiveCell(data, service, action.id)].color})` }">
                    <v-icon :icon="CELL[effectiveCell(data, service, action.id)].icon" size="14" aria-hidden="true" />
                    {{ CELL[effectiveCell(data, service, action.id)].label }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="panel-body medium mb-0" style="font-size: 12px">
          O nível efetivo é o mais restritivo entre o serviço e o teto da ação. Serviço fora da política herda “{{ LEVEL_LABEL[data.defaults.level] }}” e allowlist vazia.
        </p>
      </div>

      <div class="panel">
        <h2 class="label panel-title mt-0 mb-0">Catálogo de ações e limites de parâmetros</h2>
        <div v-for="action in data.actions" :key="action.id" class="panel-body hairline-b">
          <div class="d-flex flex-wrap align-center" style="gap: 8px">
            <strong class="mono">{{ action.id }}</strong>
            <v-chip>{{ action.reversible ? 'reversível' : 'irreversível' }}</v-chip>
            <v-chip>teto: {{ LEVEL_LABEL[action.maxAutonomy] }}</v-chip>
          </div>
          <p class="medium mt-1 mb-1">{{ action.description }}</p>
          <dl class="mono limits">
            <template v-for="(schema, name) in action.params.properties" :key="name">
              <dt>{{ name }}</dt>
              <dd>{{ describeLimit(schema) }}</dd>
            </template>
          </dl>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.scroll {
  overflow-x: auto;
}
.matrix {
  width: 100%;
  border-collapse: collapse;
}
.matrix th,
.matrix td {
  text-align: left;
  padding: 6px 12px;
  border-bottom: 1px solid var(--hairline);
  font-weight: 400;
  font-size: 12px;
}
.matrix thead th {
  white-space: nowrap;
}
.cell {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: rgb(var(--tone));
}
.limits {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 16px;
  margin: 0;
  font-size: 12px;
}
.limits dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
