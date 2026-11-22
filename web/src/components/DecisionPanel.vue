<script setup lang="ts">
import { computed, ref } from 'vue';
import { ApiError } from '@/api/client';
import { useCancel, useDecide } from '@/api/queries';
import { reasonLimits, requiresServiceConfirmation } from '@/domain/approval';

const props = defineProps<{
  approvalId: string;
  incidentId: string;
  service: string;
  action: string;
  /** Texto curto do que a ação faz, para a confirmação. */
  summary?: string;
}>();
const emit = defineEmits<{ done: [kind: 'approve' | 'reject' | 'cancel'] }>();

type Mode = 'approve' | 'reject' | 'cancel' | null;
const mode = ref<Mode>(null);
const reason = ref('');
const typedService = ref('');
const error = ref<string | null>(null);

const decide = useDecide();
const cancel = useCancel();
const busy = computed(() => decide.isPending.value || cancel.isPending.value);

const needsTyping = computed(() => requiresServiceConfirmation(props.service, props.action));
const reasonValid = computed(() => reason.value.trim().length >= reasonLimits.min && reason.value.trim().length <= reasonLimits.max);
const canSubmit = computed(() => {
  if (mode.value === 'approve') return !needsTyping.value || typedService.value === props.service;
  return reasonValid.value;
});

function open(next: Mode) {
  mode.value = mode.value === next ? null : next;
  error.value = null;
}

async function submit() {
  const current = mode.value;
  if (!current || !canSubmit.value) return;
  error.value = null;
  try {
    if (current === 'cancel') await cancel.mutateAsync({ incidentId: props.incidentId, reason: reason.value.trim() });
    else await decide.mutateAsync({ approvalId: props.approvalId, decision: current, ...(reason.value.trim() ? { reason: reason.value.trim() } : {}) });
    emit('done', current);
    mode.value = null;
    reason.value = '';
    typedService.value = '';
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : 'Não foi possível falar com o copiloto.';
  }
}

const CONFIRM_LABEL = { approve: 'Confirmar aprovação', reject: 'Confirmar recusa', cancel: 'Confirmar cancelamento' } as const;
</script>

<template>
  <div class="decision">
    <div class="d-flex flex-wrap" style="gap: 8px">
      <v-btn color="primary" variant="flat" :disabled="busy" :aria-expanded="mode === 'approve'" data-test="approve" @click="open('approve')">Aprovar</v-btn>
      <v-btn color="error" :disabled="busy" :aria-expanded="mode === 'reject'" data-test="reject" @click="open('reject')">Recusar</v-btn>
      <v-btn variant="text" :disabled="busy" :aria-expanded="mode === 'cancel'" data-test="cancel" @click="open('cancel')">Cancelar incidente</v-btn>
    </div>

    <form v-if="mode" class="confirm" @submit.prevent="submit">
      <p v-if="mode === 'approve'" class="mt-0">
        Aprovar executa <code class="mono">{{ action }}</code> em <code class="mono">{{ service }}</code
        >{{ summary ? `: ${summary}` : '' }}. Em dry-run, só descreve o que seria feito.
      </p>
      <p v-else-if="mode === 'reject'" class="mt-0">A ação não roda e o motivo fica registrado na trilha de auditoria.</p>
      <p v-else class="mt-0">O pedido sai da fila e ninguém mais poderá aprovar esta ação. O motivo fica na trilha.</p>

      <v-text-field
        v-if="mode === 'approve' && needsTyping"
        v-model="typedService"
        :label="`Digite ${service} para confirmar`"
        autocomplete="off"
        class="mb-2"
        data-test="type-service"
      />
      <v-textarea
        v-if="mode !== 'approve'"
        v-model="reason"
        label="Motivo (obrigatório)"
        rows="2"
        auto-grow
        :counter="reasonLimits.max"
        :maxlength="reasonLimits.max"
        class="mb-2"
        data-test="reason"
      />
      <v-alert v-if="error" type="error" class="mb-2" role="alert">{{ error }}</v-alert>
      <div class="d-flex" style="gap: 8px">
        <v-btn type="submit" :color="mode === 'approve' ? 'primary' : 'error'" variant="flat" :disabled="!canSubmit || busy" :loading="busy" data-test="confirm">
          {{ CONFIRM_LABEL[mode] }}
        </v-btn>
        <v-btn variant="text" :disabled="busy" @click="mode = null">Voltar</v-btn>
      </div>
    </form>
  </div>
</template>

<style scoped>
.confirm {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--hairline);
}
</style>
