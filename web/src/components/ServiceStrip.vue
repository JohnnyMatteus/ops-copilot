<script setup lang="ts">
import { computed } from 'vue';
import { usePolicy } from '@/api/queries';
import type { Incident } from '@/api/schemas';
import { isOpen, STATUS_LABEL, statusOf } from '@/domain/status';

const props = defineProps<{ incidents: readonly Incident[]; now: number }>();
const policy = usePolicy();

const services = computed(() => {
  const names = new Set([...(policy.data.value?.services.map((s) => s.name) ?? []), ...props.incidents.map((i) => i.service)]);
  return [...names].sort().map((name) => {
    const latest = props.incidents.find((incident) => incident.service === name);
    const status = latest ? statusOf(latest, props.now) : null;
    return { name, latest, status, open: status !== null && isOpen(status) };
  });
});
</script>

<template>
  <div class="strip" aria-label="Serviços monitorados">
    <div v-for="service in services" :key="service.name" class="cell mono" :class="{ open: service.open }">
      <span class="name">{{ service.name }}</span>
      <span v-if="service.latest && service.status" class="medium">
        {{ service.open ? `alerta ativo: ${service.latest.alertname}` : `último: ${service.latest.alertname}, ${STATUS_LABEL[service.status]}` }}
      </span>
      <span v-else class="medium">sem alerta</span>
    </div>
  </div>
</template>

<style scoped>
.strip {
  display: flex;
  flex-wrap: wrap;
  border: 1px solid var(--hairline);
  border-radius: 4px;
  margin-bottom: 12px;
}
.cell {
  flex: 1 1 260px;
  display: flex;
  flex-direction: column;
  padding: 6px 12px;
  font-size: 12px;
  line-height: 18px;
  border-right: 1px solid var(--hairline);
}
.cell:last-child {
  border-right: 0;
}
.name {
  font-weight: 600;
}
.open {
  background: rgba(var(--v-theme-primary), 0.1);
}
</style>
