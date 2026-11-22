import { createRouter, createWebHistory } from 'vue-router';
import { token } from '@/auth/session';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { public: true, title: 'Entrar' } },
    { path: '/callback', name: 'callback', component: () => import('@/views/CallbackView.vue'), meta: { public: true, title: 'Entrando' } },
    { path: '/', name: 'incidents', component: () => import('@/views/IncidentsView.vue'), meta: { title: 'Incidentes' } },
    { path: '/incidents/:id', name: 'incident', component: () => import('@/views/IncidentView.vue'), meta: { title: 'Investigação' } },
    { path: '/approvals', name: 'approvals', component: () => import('@/views/ApprovalsView.vue'), meta: { title: 'Aprovações' } },
    { path: '/audit', name: 'audit', component: () => import('@/views/AuditView.vue'), meta: { title: 'Auditoria' } },
    { path: '/policy', name: 'policy', component: () => import('@/views/PolicyView.vue'), meta: { title: 'Política' } },
    { path: '/playbooks', name: 'playbooks', component: () => import('@/views/PlaybooksView.vue'), meta: { title: 'Playbooks' } },
    { path: '/budget', name: 'budget', component: () => import('@/views/BudgetView.vue'), meta: { title: 'Orçamento' } },
    { path: '/:rest(.*)*', redirect: '/' },
  ],
});

router.beforeEach((to) => {
  if (!to.meta['public'] && !token.value) return { name: 'login', query: { next: to.fullPath } };
  return true;
});
router.afterEach((to) => {
  document.title = `${String(to.meta['title'] ?? 'Vigília')} · Vigília`;
});
