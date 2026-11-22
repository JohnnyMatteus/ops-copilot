<script setup lang="ts">
import { mdiShieldCheckOutline } from '@mdi/js';
import { useQueryClient } from '@tanstack/vue-query';
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAudit, useVerifyChain } from '@/api/queries';
import type { Verification } from '@/api/schemas';
import HashLink from '@/components/signature/HashLink.vue';
import { dateTime, number } from '@/domain/format';

const route = useRoute();
const router = useRouter();
const incident = computed(() => (typeof route.query['incident'] === 'string' ? route.query['incident'] : null));
const audit = useAudit(incident);
const verify = useVerifyChain();
const client = useQueryClient();
const verification = computed(() => client.getQueryData<Verification>(['verification']));

const rows = computed(() => {
  const records = [...(audit.data.value ?? [])];
  return records
    .map((record, index) => {
      const before = records[index - 1];
      // Elo aberto: o servidor achou a quebra neste registro, ou o hash anterior não bate com o vizinho consecutivo.
      const brokenByServer = verification.value?.valid === false && verification.value.brokenAt !== undefined && record.seq >= verification.value.brokenAt;
      const brokenLocally = before !== undefined && before.seq + 1 === record.seq && before.hash !== record.prevHash;
      return { record, broken: brokenByServer && record.seq === verification.value?.brokenAt ? true : brokenLocally };
    })
    .reverse();
});

const setIncident = (value: string | null) => router.replace({ query: value ? { incident: value } : {} });
const detail = (details: Record<string, unknown>) => {
  const { reason, action, approvalId, reasons } = details as { reason?: string; action?: string; approvalId?: string; reasons?: string[] };
  return reason ?? reasons?.join(' ') ?? action ?? approvalId ?? '';
};
</script>

<template>
  <div class="page">
    <div class="d-flex flex-wrap align-center mb-3" style="gap: 12px">
      <h1 class="page-title mb-0">Trilha de auditoria</h1>
      <v-chip v-if="incident" closable class="mono" @click:close="setIncident(null)">incidente {{ incident.slice(0, 8) }}</v-chip>
      <v-spacer />
      <v-btn :loading="verify.isPending.value" color="primary" @click="verify.mutate()">
        <v-icon :icon="mdiShieldCheckOutline" size="16" start />Verificar cadeia
      </v-btn>
    </div>

    <v-alert v-if="verification" :type="verification.valid ? 'success' : 'error'" class="mb-3" role="status">
      <template v-if="verification.valid">
        Cadeia íntegra: {{ number(verification.records) }} registros encadeados.
        <span v-if="verification.head" class="mono">cabeça #{{ verification.head.seq }} <HashLink :hash="verification.head.hash" /></span>
      </template>
      <template v-else>Cadeia interrompida no registro #{{ verification.brokenAt }}: algum registro foi alterado ou removido.</template>
    </v-alert>

    <v-alert v-if="audit.isError.value" type="error" role="alert" class="mb-3">Não foi possível ler a trilha.</v-alert>

    <div class="panel">
      <table class="table">
        <thead>
          <tr class="label medium"><th>#</th><th>hora</th><th>ator</th><th>evento</th><th>detalhe</th><th>elo de hash</th></tr>
        </thead>
        <tbody>
          <tr v-if="audit.isPending.value"><td colspan="6" class="medium">Carregando a trilha…</td></tr>
          <tr v-else-if="rows.length === 0"><td colspan="6">Nenhum registro{{ incident ? ' para este incidente' : '' }}.</td></tr>
          <tr v-for="{ record, broken } in rows" :key="record.seq">
            <td class="mono tabular">{{ record.seq }}</td>
            <td class="mono tabular">{{ dateTime(record.at) }}</td>
            <td class="mono" :class="{ human: record.actor.startsWith('human:') }">{{ record.actor }}</td>
            <td><code class="mono">{{ record.event }}</code></td>
            <td class="medium detail">
              <a v-if="!incident" href="#" @click.prevent="setIncident(record.incidentId)">{{ record.incidentId.slice(0, 8) }}</a>
              {{ detail(record.details) }}
            </td>
            <td><HashLink :hash="record.hash" :broken="broken" /></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="medium mt-3" style="font-size: 12px">
      Cada registro guarda o hash do anterior. Os três quadrados colorem o hash: hashes iguais têm cores iguais. Alterar um registro quebra o elo.
    </p>
  </div>
</template>

<style scoped>
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
th,
td {
  text-align: left;
  padding: 0 12px;
  height: 32px;
  border-bottom: 1px solid var(--hairline);
  white-space: nowrap;
}
.detail {
  white-space: normal;
  max-width: 420px;
  overflow-wrap: anywhere;
}
.human {
  color: rgb(var(--v-theme-primary));
}
.panel {
  overflow-x: auto;
}
</style>
