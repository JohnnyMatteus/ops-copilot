<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, get } from '@/api/client';
import { useConfig } from '@/api/queries';
import { OperatorSchema } from '@/api/schemas';
import { createUserManager } from '@/auth/oidc';
import { setToken } from '@/auth/session';

const route = useRoute();
const router = useRouter();
const config = useConfig();
const value = ref('');
const error = ref<string | null>(null);
const busy = ref(false);

async function enter() {
  busy.value = true;
  error.value = null;
  setToken(value.value.trim());
  try {
    await get(OperatorSchema, '/me');
    await router.push(typeof route.query['next'] === 'string' ? route.query['next'] : '/');
  } catch (caught) {
    setToken(null);
    error.value = caught instanceof ApiError && caught.status === 401 ? 'Token não reconhecido.' : 'Não foi possível falar com o copiloto.';
  } finally {
    busy.value = false;
  }
}

async function enterWithOidc() {
  if (config.data.value?.oidc) await createUserManager(config.data.value.oidc).signinRedirect();
}
</script>

<template>
  <div class="login">
    <section class="panel" aria-labelledby="login-title">
      <div class="panel-title d-flex align-center" style="gap: 10px">
        <span class="mark" aria-hidden="true"><span /><span /><span class="amber" /></span>
        <h1 id="login-title" class="label" style="margin: 0">Vigília · ops-copilot</h1>
      </div>
      <div class="panel-body">
        <p class="mt-0 medium">O copiloto investiga, o gate decide o que pode rodar e cada passo fica na fita. Entre para operar.</p>
        <v-alert v-if="config.isError.value" type="error" class="mb-3" role="alert">O copiloto não respondeu em /api/config. Ele está no ar?</v-alert>
        <form v-if="config.data.value?.tokenLogin" @submit.prevent="enter">
          <v-text-field v-model="value" label="Token de operador" type="password" autocomplete="off" autofocus class="mb-2" />
          <v-alert v-if="error" type="error" class="mb-2" role="alert">{{ error }}</v-alert>
          <v-btn type="submit" color="primary" variant="flat" block :loading="busy" :disabled="value.trim().length < 16">Entrar</v-btn>
        </form>
        <v-btn v-if="config.data.value?.oidc" class="mt-3" block @click="enterWithOidc">Entrar com OIDC</v-btn>
        <p v-if="config.data.value" class="mono medium mb-0 mt-4" style="font-size: 12px">
          v{{ config.data.value.version }} · execução {{ config.data.value.executionMode }} · LLM {{ config.data.value.llmProvider }}
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.login {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 16px;
}
.login .panel {
  width: min(420px, 100%);
}
.mark {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 20px;
}
.mark span {
  height: 4px;
  background: rgb(var(--v-theme-secondary));
}
.mark .amber {
  background: rgb(var(--v-theme-primary));
}
</style>
