<script setup lang="ts">
import type { GateCheck } from '@/api/schemas';
import { CHECK_LABEL } from '@/domain/verdict';

defineProps<{ checks: readonly GateCheck[] }>();
</script>

<template>
  <ul class="checks mono" aria-label="Checagens do gate">
    <li v-for="check in checks" :key="check.check" :class="check.passed ? 'ok' : 'fail'">
      <span class="mark" aria-hidden="true">{{ check.passed ? '✓' : '✕' }}</span>
      <span class="sr-only">{{ check.passed ? 'passou:' : 'falhou:' }}</span>
      <span>{{ CHECK_LABEL[check.check] ?? check.check }}</span>
      <span class="medium">{{ check.detail }}</span>
    </li>
  </ul>
</template>

<style scoped>
.checks {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  font-size: 12px;
  line-height: 18px;
}
li {
  display: grid;
  grid-template-columns: 14px auto 1fr;
  gap: 6px;
}
.ok .mark {
  color: rgb(var(--v-theme-verdict-auto));
}
.fail .mark {
  color: rgb(var(--v-theme-verdict-blocked));
}
.fail > span:nth-child(3) {
  color: rgb(var(--v-theme-verdict-blocked));
}
</style>
