import { VueQueryPlugin } from '@tanstack/vue-query';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import DecisionPanel from '@/components/DecisionPanel.vue';
import RollbackPanel from '@/components/RollbackPanel.vue';
import GateTape from '@/components/signature/GateTape.vue';
import HashLink from '@/components/signature/HashLink.vue';
import { awaitingReport } from './fixtures';

describe('GateTape', () => {
  it('mostra ✓ e ✕ como texto, com rótulos para leitor de tela', () => {
    const wrapper = mount(GateTape, { props: { incident: awaitingReport() } });
    expect(wrapper.attributes('aria-label')).toMatch(/Fita do gate/);
    const text = wrapper.text();
    expect(text).toContain('✓');
    expect(text).toContain('✕');
    expect(text).toContain('maxMessages: acima do limite');
    expect(wrapper.find('[role="img"]').attributes('aria-label')).toMatch(/precisa de uma pessoa/);
  });
});

describe('HashLink', () => {
  it('elo aberto mostra "cadeia interrompida" em texto', () => {
    const hash = 'ab'.repeat(32);
    expect(mount(HashLink, { props: { hash, broken: true } }).text()).toContain('cadeia interrompida');
    expect(mount(HashLink, { props: { hash } }).text()).not.toContain('interrompida');
  });
});

describe('DecisionPanel', () => {
  const mountPanel = (service: string, action: string) =>
    mount(DecisionPanel, {
      props: { approvalId: 'a', incidentId: 'i', service, action },
      global: { plugins: [VueQueryPlugin] },
      attachTo: document.body,
    });

  it('recusar só confirma com motivo', async () => {
    const wrapper = mountPanel('saas-multitenant', 'toggle_feature_flag');
    await wrapper.get('[data-test="reject"]').trigger('click');
    const confirm = () => wrapper.get('[data-test="confirm"]').element as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);
    await wrapper.get('[data-test="reason"] textarea').setValue('fora da janela de mudança');
    expect(confirm().disabled).toBe(false);
    wrapper.unmount();
  });

  it('aprovar ação de pagamentos exige digitar o nome do serviço', async () => {
    const wrapper = mountPanel('payments-events-go', 'replay_dlq_batch');
    await wrapper.get('[data-test="approve"]').trigger('click');
    const confirm = () => wrapper.get('[data-test="confirm"]').element as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);
    await wrapper.get('[data-test="type-service"] input').setValue('payments-events-go');
    expect(confirm().disabled).toBe(false);
    wrapper.unmount();
  });

  it('aprovar ação sem dinheiro não pede digitação', async () => {
    const wrapper = mountPanel('saas-multitenant', 'toggle_feature_flag');
    await wrapper.get('[data-test="approve"]').trigger('click');
    expect(wrapper.find('[data-test="type-service"]').exists()).toBe(false);
    expect((wrapper.get('[data-test="confirm"]').element as HTMLButtonElement).disabled).toBe(false);
    wrapper.unmount();
  });
});

describe('RollbackPanel', () => {
  it('reverter só confirma com motivo', async () => {
    const wrapper = mount(RollbackPanel, {
      props: { incidentId: 'i', undoAction: 'restore_deployment_replicas', summary: '4 → 6' },
      global: { plugins: [VueQueryPlugin] },
      attachTo: document.body,
    });
    await wrapper.get('[data-test="rollback"]').trigger('click');
    const confirm = () => wrapper.get('[data-test="rollback-confirm"]').element as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);
    await wrapper.get('[data-test="rollback-reason"] textarea').setValue('latência voltou');
    expect(confirm().disabled).toBe(false);
    wrapper.unmount();
  });
});
