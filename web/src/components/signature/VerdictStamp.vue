<script setup lang="ts">
import { computed } from 'vue';
import type { Verdict } from '@/api/schemas';
import { VERDICT, VERDICT_LONG } from '@/domain/verdict';

const props = defineProps<{ verdict: Verdict }>();
const style = computed(() => VERDICT[props.verdict]);
</script>

<template>
  <span class="stamp label" :style="{ '--tone': `var(--v-theme-${style.color})` }" role="img" :aria-label="`Veredicto do gate: ${VERDICT_LONG[verdict]}`">
    <v-icon :icon="style.icon" size="14" aria-hidden="true" />
    {{ style.label }}
  </span>
</template>

<style scoped>
.stamp {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border: 1px solid rgb(var(--tone));
  border-radius: 2px;
  color: rgb(var(--tone));
  white-space: nowrap;
}
</style>
