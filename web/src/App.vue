<script setup lang="ts">
import { mdiBookOpenVariantOutline, mdiBrightness6, mdiFormatListBulleted, mdiGaugeLow, mdiHandBackLeftOutline, mdiLogout, mdiMagnify, mdiScaleBalance, mdiShieldLockOutline } from '@mdi/js';
import { useStorage } from '@vueuse/core';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useTheme } from 'vuetify';
import { useApprovals, useConfig, useMe } from '@/api/queries';
import { setToken, token } from '@/auth/session';
import CommandPalette from '@/components/CommandPalette.vue';

const route = useRoute();
const router = useRouter();
const theme = useTheme();

// Dark é o padrão: o plantão acontece de madrugada.
const mode = useStorage<'vigiliaDark' | 'vigiliaLight'>('vigilia.theme', 'vigiliaDark');
watch(mode, (value) => theme.change(value), { immediate: true });
const toggleTheme = () => (mode.value = mode.value === 'vigiliaDark' ? 'vigiliaLight' : 'vigiliaDark');

const paletteOpen = ref(false);
const config = useConfig();
const me = useMe();
const approvals = useApprovals();
const pending = computed(() => approvals.data.value?.length ?? 0);

const nav = computed(() => [
  { to: '/', label: 'Incidentes', icon: mdiFormatListBulleted, badge: 0 },
  { to: '/approvals', label: 'Aprovações', icon: mdiHandBackLeftOutline, badge: pending.value },
  { to: '/audit', label: 'Auditoria', icon: mdiShieldLockOutline, badge: 0 },
  { to: '/policy', label: 'Política', icon: mdiScaleBalance, badge: 0 },
  { to: '/playbooks', label: 'Playbooks', icon: mdiBookOpenVariantOutline, badge: 0 },
  { to: '/budget', label: 'Orçamento', icon: mdiGaugeLow, badge: 0 },
]);
const isActive = (to: string) => (to === '/' ? route.path === '/' || route.path.startsWith('/incidents') : route.path.startsWith(to));

// Um 401 em qualquer chamada limpa a sessão; a tela volta para o login.
watch(token, (value) => {
  if (!value && route.name !== 'login') void router.push({ name: 'login' });
});
const signOut = () => setToken(null);
const authenticated = computed(() => token.value !== null && route.name !== 'login' && route.name !== 'callback');
</script>

<template>
  <v-app>
    <template v-if="authenticated">
      <v-navigation-drawer aria-label="Navegação principal">
        <div class="d-flex flex-column align-center py-2" style="gap: 2px">
          <router-link to="/" class="rail-mark" aria-label="Vigília: início">
            <span /><span /><span class="amber" />
          </router-link>
          <v-tooltip v-for="item in nav" :key="item.to" location="end">
            <template #activator="{ props }">
              <v-btn v-bind="props" :to="item.to" :aria-label="item.label" :active="isActive(item.to)" variant="text" icon size="small" class="rail-btn">
                <v-badge v-if="item.badge" :content="item.badge" color="primary" floating>
                  <v-icon :icon="item.icon" size="18" />
                </v-badge>
                <v-icon v-else :icon="item.icon" size="18" />
              </v-btn>
            </template>
            {{ item.label }}
          </v-tooltip>
        </div>
      </v-navigation-drawer>

      <v-app-bar>
        <div class="d-flex align-center px-3 w-100" style="gap: 12px">
          <span class="label">Vigília</span>
          <span class="medium">{{ String(route.meta['title'] ?? '') }}</span>
          <v-spacer />
          <v-chip v-if="config.data.value" :color="config.data.value.executionMode === 'dry-run' ? 'success' : 'error'" class="mono">
            {{ config.data.value.executionMode }}
          </v-chip>
          <v-btn variant="text" size="small" aria-label="Abrir paleta de comandos (Ctrl ou Cmd + K)" @click="paletteOpen = true">
            <v-icon :icon="mdiMagnify" size="16" start />
            <kbd class="mono">⌘K</kbd>
          </v-btn>
          <span v-if="me.data.value" class="mono medium d-none d-sm-inline" :title="`entrou por ${me.data.value.via}`">{{ me.data.value.email }}</span>
          <v-btn icon variant="text" size="small" aria-label="Alternar tema claro e escuro" @click="toggleTheme">
            <v-icon :icon="mdiBrightness6" size="18" />
          </v-btn>
          <v-btn icon variant="text" size="small" aria-label="Sair" @click="signOut">
            <v-icon :icon="mdiLogout" size="18" />
          </v-btn>
        </div>
      </v-app-bar>
      <CommandPalette v-model="paletteOpen" @toggle-theme="toggleTheme" @sign-out="signOut" />
    </template>

    <v-main>
      <router-view />
    </v-main>
  </v-app>
</template>

<style scoped>
.rail-mark {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 20px;
  margin: 6px 0 10px;
}
.rail-mark span {
  height: 4px;
  background: rgb(var(--v-theme-secondary));
}
.rail-mark .amber {
  background: rgb(var(--v-theme-primary));
}
kbd {
  font-size: 12px;
}
</style>
