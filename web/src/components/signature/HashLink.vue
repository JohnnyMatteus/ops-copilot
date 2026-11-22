<script setup lang="ts">
import { computed } from 'vue';
import { hashColors, shortHash } from '@/domain/hash';

const props = defineProps<{
  hash: string;
  /** Elo aberto: o hash anterior não confere com o registro de trás. */
  broken?: boolean;
}>();
const colors = computed(() => hashColors(props.hash));
</script>

<template>
  <span class="link mono" :class="{ broken }" :title="hash">
    <span class="line" aria-hidden="true" />
    <span class="squares" aria-hidden="true">
      <i v-for="(color, index) in colors" :key="index" :style="{ background: color }" />
    </span>
    <span>{{ shortHash(hash) }}</span>
    <span v-if="broken" class="warn"><span aria-hidden="true">✕ </span>cadeia interrompida</span>
    <span v-else class="sr-only">elo íntegro</span>
  </span>
</template>

<style scoped>
.link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  position: relative;
}
.line {
  width: 10px;
  height: 1px;
  background: var(--hairline);
}
.broken .line {
  background: transparent;
  border-top: 1px dashed rgb(var(--v-theme-verdict-blocked));
}
.squares {
  display: inline-flex;
  gap: 2px;
}
i {
  width: 8px;
  height: 8px;
  display: block;
}
.broken {
  color: rgb(var(--v-theme-verdict-blocked));
}
.warn {
  font-weight: 600;
}
</style>
