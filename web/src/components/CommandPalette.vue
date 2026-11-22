<script setup lang="ts">
import { onKeyStroke } from '@vueuse/core';
import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useIncidents } from '@/api/queries';
import { statusOf, STATUS_LABEL } from '@/domain/status';

const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ 'toggle-theme': []; 'sign-out': [] }>();

const router = useRouter();
const incidents = useIncidents();
const query = ref('');
const cursor = ref(0);
const input = ref<{ focus: () => void } | null>(null);

interface Command {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly run: () => void;
}

const go = (path: string) => () => void router.push(path);
const base: Command[] = [
  { id: 'incidents', label: 'Ir para incidentes', hint: 'tela', run: go('/') },
  { id: 'approvals', label: 'Ir para aprovações', hint: 'tela', run: go('/approvals') },
  { id: 'audit', label: 'Ir para auditoria', hint: 'tela', run: go('/audit') },
  { id: 'policy', label: 'Ir para limites de autonomia', hint: 'tela', run: go('/policy') },
  { id: 'playbooks', label: 'Ir para playbooks', hint: 'tela', run: go('/playbooks') },
  { id: 'budget', label: 'Ir para orçamento', hint: 'tela', run: go('/budget') },
  { id: 'theme', label: 'Alternar tema claro e escuro', hint: 'ação', run: () => emit('toggle-theme') },
  { id: 'out', label: 'Sair', hint: 'ação', run: () => emit('sign-out') },
];

const commands = computed<Command[]>(() => [
  ...base,
  ...(incidents.data.value ?? []).slice(0, 15).map((incident) => ({
    id: incident.incidentId,
    label: `${incident.alertname} · ${incident.service}`,
    hint: STATUS_LABEL[statusOf(incident, Date.now())],
    run: go(`/incidents/${incident.incidentId}`),
  })),
]);

const matches = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return needle ? commands.value.filter((command) => `${command.label} ${command.hint}`.toLowerCase().includes(needle)) : commands.value;
});
watch(query, () => (cursor.value = 0));
watch(open, async (value) => {
  if (!value) return;
  query.value = '';
  cursor.value = 0;
  await nextTick();
  input.value?.focus();
});

function choose(command: Command | undefined) {
  if (!command) return;
  open.value = false;
  command.run();
}

onKeyStroke('k', (event) => {
  if (event.metaKey || event.ctrlKey) {
    event.preventDefault();
    open.value = !open.value;
  }
});
function onKey(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') cursor.value = Math.min(cursor.value + 1, matches.value.length - 1);
  else if (event.key === 'ArrowUp') cursor.value = Math.max(cursor.value - 1, 0);
  else if (event.key === 'Enter') choose(matches.value[cursor.value]);
  else return;
  event.preventDefault();
}
</script>

<template>
  <v-dialog v-model="open" max-width="560" aria-label="Paleta de comandos" location="top" content-class="palette">
    <div class="panel" @keydown="onKey">
      <v-text-field ref="input" v-model="query" placeholder="Buscar tela, incidente ou ação" aria-label="Buscar comando" variant="plain" autofocus class="px-3" />
      <div role="listbox" aria-label="Comandos" class="list">
        <div
          v-for="(command, index) in matches"
          :key="command.id"
          role="option"
          :aria-selected="index === cursor"
          class="row-link"
          :class="{ 'is-active': index === cursor }"
          style="grid-template-columns: 1fr auto"
          @click="choose(command)"
          @mousemove="cursor = index"
        >
          <span>{{ command.label }}</span>
          <span class="label medium">{{ command.hint }}</span>
        </div>
        <div v-if="matches.length === 0" class="px-3 py-3 medium">Nenhum comando para “{{ query }}”.</div>
      </div>
    </div>
  </v-dialog>
</template>

<style scoped>
.list {
  max-height: 360px;
  overflow-y: auto;
  border-top: 1px solid var(--hairline);
}
</style>
