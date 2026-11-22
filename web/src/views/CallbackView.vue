<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { get } from '@/api/client';
import { ConfigSchema } from '@/api/schemas';
import { createUserManager } from '@/auth/oidc';
import { setToken } from '@/auth/session';

const router = useRouter();
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const config = await get(ConfigSchema, '/config');
    if (!config.oidc) throw new Error('OIDC não configurado no copiloto.');
    const user = await createUserManager(config.oidc).signinCallback();
    if (!user) throw new Error('Resposta do emissor sem usuário.');
    setToken(user.access_token);
    await router.replace('/');
  } catch (caught) {
    error.value = (caught as Error).message;
  }
});
</script>

<template>
  <div class="page">
    <v-alert v-if="error" type="error" role="alert">Falha no login OIDC: {{ error }}. <router-link to="/login">Voltar</router-link></v-alert>
    <p v-else class="medium">Concluindo o login…</p>
  </div>
</template>
