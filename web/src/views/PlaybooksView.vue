<script setup lang="ts">
import { computed } from 'vue';
import { usePlaybooks } from '@/api/queries';
import { LEVEL_LABEL } from '@/domain/verdict';

const playbooks = usePlaybooks();
const data = computed(() => playbooks.data.value);
</script>

<template>
  <div class="page">
    <h1 class="page-title">Playbooks</h1>
    <v-alert v-if="playbooks.isError.value" type="error" role="alert">Não foi possível carregar os playbooks.</v-alert>
    <p v-else-if="playbooks.isPending.value" class="medium">Carregando os playbooks…</p>
    <p v-if="data" class="mt-0">
      Leitura apenas: versionados em <code class="mono">{{ data.source.file }}</code>, commit <code class="mono">{{ data.source.commit }}</code>. O playbook diz o que investigar; se a
      ação roda sozinha é a política.
    </p>

    <v-expansion-panels v-if="data" variant="accordion" multiple>
      <v-expansion-panel v-for="playbook in data.playbooks" :key="playbook.metadata.id" :title="`${playbook.metadata.id}@${playbook.metadata.version}`">
        <v-expansion-panel-text>
          <p class="mt-0">{{ playbook.metadata.description }}</p>
          <p class="mono medium">
            casa com {{ playbook.match.alertname }} em {{ playbook.match.service }} · dono {{ playbook.metadata.owner }} · teto {{ LEVEL_LABEL[playbook.autonomy.maxLevel] }} · confiança mínima
            para auto {{ playbook.autonomy.minConfidenceForAuto }}
          </p>

          <h3 class="label mt-4 mb-1">Sinais</h3>
          <div v-for="metric in playbook.signals.metrics" :key="metric.name" class="mb-2">
            <strong class="mono">{{ metric.name }}</strong> <span class="medium">{{ metric.description }} ({{ metric.kind }}, {{ metric.window }})</span>
            <code class="mono block">{{ metric.query }}</code>
          </div>
          <div v-for="trace in playbook.signals.traces" :key="trace.name" class="mb-2">
            <strong class="mono">{{ trace.name }}</strong> <span class="medium">{{ trace.description }} (traces de {{ trace.service }}, {{ trace.lookback }})</span>
          </div>

          <h3 class="label mt-4 mb-1">Hipóteses</h3>
          <ul class="mt-0">
            <li v-for="hypothesis in playbook.diagnosis.hypotheses" :key="hypothesis.id">
              <code class="mono">{{ hypothesis.id }}</code>: {{ hypothesis.description }}
            </li>
          </ul>

          <h3 class="label mt-4 mb-1">Ações permitidas</h3>
          <ul class="mt-0">
            <li v-for="action in playbook.actions" :key="action.action">
              <code class="mono">{{ action.action }}</code> quando <code class="mono">{{ action.when.join(', ') }}</code
              ><span v-if="Object.keys(action.params).length > 0" class="mono medium"> · fixo {{ JSON.stringify(action.params) }}</span>
              <div class="medium">{{ action.rationale }}</div>
            </li>
          </ul>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>
  </div>
</template>

<style scoped>
.block {
  display: block;
  margin-top: 4px;
  padding: 4px 8px;
  background: rgb(var(--v-theme-surface-variant));
  border-radius: 2px;
  overflow-x: auto;
  white-space: pre;
}
</style>
