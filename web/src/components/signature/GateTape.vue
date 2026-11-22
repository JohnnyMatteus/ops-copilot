<script setup lang="ts">
import { computed } from 'vue';
import type { Incident } from '@/api/schemas';
import { clock, duration } from '@/domain/format';
import { buildTape, STEP_LABEL } from '@/domain/tape';
import CheckLines from './CheckLines.vue';
import VerdictStamp from './VerdictStamp.vue';

const props = defineProps<{ incident: Incident }>();
const steps = computed(() => buildTape(props.incident));
</script>

<template>
  <ol class="tape" aria-label="Fita do gate: etapas da investigação">
    <li v-for="(item, index) in steps" :key="item.step" class="segment" :class="{ dim: !item.reached }" :data-step="item.step">
      <div class="rail" aria-hidden="true"><span class="dot" :class="{ last: index === steps.length - 1 }" /></div>
      <div class="body">
        <div class="head">
          <span class="label">{{ STEP_LABEL[item.step] }}</span>
          <span v-if="item.startedAt" class="mono medium tabular">{{ clock(item.startedAt) }} · {{ duration(item.durationMs ?? 0) }}</span>
          <VerdictStamp v-if="item.verdict" :verdict="item.verdict" />
        </div>
        <p class="stamp-text">{{ item.stamp }}</p>
        <CheckLines v-if="item.checks.length" :checks="item.checks" />
        <p v-for="line in item.lines" :key="line" class="mono medium line">{{ line }}</p>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.tape {
  list-style: none;
  margin: 0;
  padding: 0;
}
.segment {
  display: grid;
  grid-template-columns: 20px 1fr;
  gap: 8px;
}
.rail {
  position: relative;
}
.rail::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 6px;
  bottom: -6px;
  width: 1px;
  background: var(--hairline);
}
.segment:last-child .rail::before {
  display: none;
}
.dot {
  position: absolute;
  left: 0;
  top: 5px;
  width: 9px;
  height: 9px;
  background: rgb(var(--v-theme-secondary));
}
.dim .dot {
  background: transparent;
  border: 1px solid var(--hairline);
}
.dim {
  opacity: 0.7;
}
.body {
  padding-bottom: 14px;
  min-width: 0;
}
.head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  min-height: 20px;
}
.stamp-text {
  margin: 2px 0 0;
  overflow-wrap: anywhere;
}
.line {
  margin: 2px 0 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}
</style>
