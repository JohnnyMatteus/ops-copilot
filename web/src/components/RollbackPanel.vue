<script setup lang="ts">
import { computed, ref } from 'vue';
import { ApiError } from '@/api/client';
import { useRollback } from '@/api/queries';
import { reasonLimits } from '@/domain/approval';

const props = defineProps<{ incidentId: string; undoAction: string; summary: string }>();
const open = ref(false);
const reason = ref('');
const error = ref<string | null>(null);
const rollback = useRollback();
const valid = computed(() => reason.value.trim().length >= reasonLimits.min && reason.value.trim().length <= reasonLimits.max);

async function submit() {
  if (!valid.value) return;
  error.value = null;
  try {
    await rollback.mutateAsync({ incidentId: props.incidentId, reason: reason.value.trim() });
    open.value = false;
    reason.value = '';
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : 'Não foi possível falar com o copiloto.';
  }
}
</script>

<template>
  <div>
    <v-btn variant="outlined" :aria-expanded="open" data-test="rollback" @click="open = !open">Reverter a ação</v-btn>
    <form v-if="open" class="mt-3" @submit.prevent="submit">
      <p class="mt-0">
        Executa <code class="mono">{{ undoAction }}</code> ({{ summary }}). Passa pelo mesmo gate, exige uma pessoa aprovadora e fica na trilha de auditoria.
      </p>
      <v-textarea v-model="reason" label="Motivo (obrigatório)" rows="2" auto-grow :maxlength="reasonLimits.max" class="mb-2" data-test="rollback-reason" />
      <v-alert v-if="error" type="error" class="mb-2" role="alert">{{ error }}</v-alert>
      <v-btn type="submit" color="error" variant="flat" :disabled="!valid || rollback.isPending.value" :loading="rollback.isPending.value" data-test="rollback-confirm">
        Confirmar rollback
      </v-btn>
    </form>
  </div>
</template>
