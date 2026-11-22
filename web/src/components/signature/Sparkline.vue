<script setup lang="ts">
import { computed } from 'vue';

// SVG próprio: séries de até ~30 pontos não justificam uma lib de gráficos. Linha de 1,5 px, sem
// preenchimento e sem animação, como a direção de identidade pede.
const props = withDefaults(defineProps<{ points: readonly { t: number; v: number }[]; width?: number; height?: number; label: string }>(), {
  width: 160,
  height: 28,
});

const path = computed(() => {
  const { points, width, height } = props;
  if (points.length < 2) return '';
  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  return points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * (width - 2) + 1;
      const y = height - 2 - ((p.v - min) / span) * (height - 4);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
});
const last = computed(() => props.points.at(-1)?.v);
</script>

<template>
  <svg :width="width" :height="height" role="img" :aria-label="`${label}: ${points.length} pontos, último valor ${last ?? 'indisponível'}`">
    <path v-if="path" :d="path" fill="none" stroke="rgb(var(--v-theme-secondary))" stroke-width="1.5" />
    <line v-else x1="0" :x2="width" :y1="height / 2" :y2="height / 2" stroke="var(--hairline)" stroke-dasharray="2 3" />
  </svg>
</template>
