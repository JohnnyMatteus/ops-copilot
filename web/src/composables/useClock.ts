// Relógio de 1 s compartilhado: contagens regressivas e "há 3 min" não precisam de um timer cada.
import { readonly, ref } from 'vue';

const now = ref(Date.now());
let started = false;

export function useClock() {
  if (!started && typeof window !== 'undefined') {
    started = true;
    window.setInterval(() => (now.value = Date.now()), 1000);
  }
  return readonly(now);
}
