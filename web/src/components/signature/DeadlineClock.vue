<script setup lang="ts">
import { computed } from 'vue';
import { useClock } from '@/composables/useClock';
import { countdown } from '@/domain/format';

const props = defineProps<{ expiresAt: string }>();
const now = useClock();
const text = computed(() => countdown(props.expiresAt, now.value));
const expired = computed(() => text.value === 'vencido');
</script>

<template>
  <span class="mono tabular clock" :class="{ expired }" :aria-label="expired ? 'Prazo vencido' : `Expira em ${text}`">
    <span aria-hidden="true">{{ expired ? 'vencido' : `expira em ${text}` }}</span>
  </span>
</template>

<style scoped>
.clock {
  color: rgb(var(--v-theme-primary));
  white-space: nowrap;
}
.expired {
  color: rgb(var(--v-theme-verdict-blocked));
}
</style>
