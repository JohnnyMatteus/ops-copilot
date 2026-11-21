import { describe, expect, it } from 'vitest';
import { LlmHttpError } from '../../src/llm/client.js';
import { ScriptedLlmClient } from '../../src/llm/scripted.js';

const request = (user: string) => ({ model: 'm', temperature: 0, messages: [{ role: 'user' as const, content: user }] });

describe('ScriptedLlmClient', () => {
  it('responde com o roteiro do playbook citado no prompt', async () => {
    const client = new ScriptedLlmClient({ 'saas-p99-latency': '{"ok":true}' });
    const response = await client.chat(request('Playbook saas-p99-latency v1.0.0\nServiço: saas'));
    expect(response).toMatchObject({ content: '{"ok":true}', model: 'scripted', costUsd: 0 });
  });

  it('sem roteiro para o playbook falha como erro de provedor', async () => {
    const client = new ScriptedLlmClient({});
    await expect(client.chat(request('Playbook outro v1'))).rejects.toBeInstanceOf(LlmHttpError);
  });

  it('o roteiro versionado é válido', async () => {
    const client = await ScriptedLlmClient.fromFile('config/scripted-llm.yaml');
    const response = await client.chat(request('Playbook payments-dlq-backlog v1.0.0'));
    expect(JSON.parse(response.content)).toMatchObject({ hypothesisId: 'downstream_recovered' });
  });
});
