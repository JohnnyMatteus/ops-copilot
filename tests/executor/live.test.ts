import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { KubeConfig } from '@kubernetes/client-node';
import { afterEach, describe, expect, it } from 'vitest';
import { RedisDlqReplayer } from '../../src/executor/dlq-redis.js';
import { HttpFeatureFlagClient } from '../../src/executor/feature-flags.js';
import { KubernetesAdapter } from '../../src/executor/kubernetes.js';
import { LiveExecutor } from '../../src/executor/live.js';
import type { DlqPort, FeatureFlagPort, KubernetesPort } from '../../src/executor/ports.js';
import { ExecutorTargetsSchema, loadExecutorTargets, TargetAllowlist } from '../../src/executor/targets.js';
import { ROOT } from '../helpers/repo.js';

const allowlist = new TargetAllowlist(
  ExecutorTargetsSchema.parse({
    apiVersion: 'ops-copilot/v1',
    kind: 'ExecutorTargets',
    kubernetes: { 'saas-multitenant': { namespace: 'saas', deployments: ['saas-api'] } },
    featureFlags: { 'saas-multitenant': ['reports.heavy_export'] },
    dlq: { 'payments-events-go': [{ queue: 'payments.events.dlq', replayTo: 'payments.events' }] },
  }),
);

class FakeKube implements KubernetesPort {
  replicasNow = 4;
  calls: string[] = [];
  async replicas() {
    return this.replicasNow;
  }
  async setReplicas(ns: string, name: string, from: number, to: number) {
    this.calls.push(`scale ${ns}/${name} ${String(from)}->${String(to)}`);
    this.replicasNow = to;
  }
  async restart(ns: string, name: string) {
    this.calls.push(`restart ${ns}/${name}`);
  }
}

class FakeFlags implements FeatureFlagPort {
  state = new Map([['reports.heavy_export', true]]);
  async isEnabled(flag: string) {
    return this.state.get(flag) ?? false;
  }
  async set(flag: string, enabled: boolean) {
    this.state.set(flag, enabled);
  }
}

const ctx = { incidentId: 'inc-1', service: 'saas-multitenant', authorizedBy: 'copilot' };
const scale = (deployment: string, delta = 2, max = 10) =>
  ({ id: 'scale_deployment', params: { deployment, replicasDelta: delta, maxReplicas: max }, reversible: true }) as const;

describe('LiveExecutor', () => {
  it('escala respeitando o teto e devolve a ação inversa com o estado anterior', async () => {
    const kube = new FakeKube();
    const executor = new LiveExecutor(allowlist, { kubernetes: kube });
    const result = await executor.execute(scale('saas-api'), ctx);
    expect(result).toMatchObject({ status: 'executed', undo: { actionId: 'restore_deployment_replicas', params: { deployment: 'saas-api', replicas: 4, expectedCurrent: 6 } } });
    expect(kube.replicasNow).toBe(6);

    kube.replicasNow = 10;
    const atCeiling = await executor.execute(scale('saas-api'), ctx);
    expect(atCeiling).toMatchObject({ status: 'executed', undo: null });
    expect(kube.replicasNow).toBe(10);
  });

  it('restauração recusa se alguém mudou o estado depois do scale, e scale não liga deployment parado', async () => {
    const kube = new FakeKube();
    const executor = new LiveExecutor(allowlist, { kubernetes: kube });
    const scaled = await executor.execute(scale('saas-api'), ctx);
    const restore = { id: 'restore_deployment_replicas', params: scaled.undo?.params ?? {}, reversible: true } as const;

    kube.replicasNow = 9; // outra pessoa ajustou à mão
    const refused = await executor.execute(restore, ctx);
    expect(refused.status).toBe('failed');
    expect(refused.detail).toMatch(/alguém mexeu/);
    expect(kube.replicasNow).toBe(9);

    kube.replicasNow = 6;
    expect((await executor.execute(restore, ctx)).status).toBe('executed');
    expect(kube.replicasNow).toBe(4);

    kube.replicasNow = 0;
    const stopped = await executor.execute(scale('saas-api'), ctx);
    expect(stopped.status).toBe('failed');
    expect(kube.replicasNow).toBe(0);
  });

  it('restauração da flag recusa se ela já foi religada por outra pessoa', async () => {
    const flags = new FakeFlags();
    const executor = new LiveExecutor(allowlist, { featureFlags: flags });
    const restore = { id: 'restore_feature_flag', params: { flag: 'reports.heavy_export', enabled: true }, reversible: true } as const;
    flags.state.set('reports.heavy_export', true);
    expect((await executor.execute(restore, ctx)).status).toBe('failed');
    flags.state.set('reports.heavy_export', false);
    expect((await executor.execute(restore, ctx)).status).toBe('executed');
  });

  it('alvo fora da allowlist nunca chega ao backend', async () => {
    const kube = new FakeKube();
    const executor = new LiveExecutor(allowlist, { kubernetes: kube });
    for (const [action, service] of [
      [scale('payments-consumer'), 'saas-multitenant'],
      [scale('saas-api'), 'payments-events-go'],
      [{ id: 'restart_pods', params: { deployment: 'saas-api' }, reversible: false }, 'serviço-desconhecido'],
    ] as const) {
      const result = await executor.execute(action, { ...ctx, service });
      expect(result.status).toBe('failed');
      expect(result.detail).toMatch(/allowlist/);
    }
    expect(kube.calls).toEqual([]);
  });

  it('sem backend configurado falha de forma explícita, sem simular sucesso', async () => {
    const executor = new LiveExecutor(allowlist, {});
    expect((await executor.execute(scale('saas-api'), ctx)).detail).toMatch(/ainda não tem adaptador|não configurado/);
    expect((await executor.execute({ id: 'notify_oncall', params: { channel: '#x' }, reversible: true }, ctx)).status).toBe('failed');
    expect((await executor.execute({ id: 'reset_consumer_offsets', params: {}, reversible: false }, ctx)).status).toBe('failed');
  });

  it('notify_oncall avisa o canal pelo notificador e falha sem ele', async () => {
    const sent: [string, string][] = [];
    const executor = new LiveExecutor(allowlist, { notifier: { notify: async (channel, text) => void sent.push([channel, text]) } });
    const result = await executor.execute({ id: 'notify_oncall', params: { channel: '#plantao-agendamento' }, reversible: true }, ctx);
    expect(result.status).toBe('executed');
    expect(sent[0]?.[0]).toBe('#plantao-agendamento');
    expect(sent[0]?.[1]).toContain('inc-1');
  });

  it('flag: desliga, guarda como religar e é idempotente', async () => {
    const flags = new FakeFlags();
    const executor = new LiveExecutor(allowlist, { featureFlags: flags });
    const off = { id: 'toggle_feature_flag', params: { flag: 'reports.heavy_export', enabled: false }, reversible: true } as const;
    expect(await executor.execute(off, ctx)).toMatchObject({ status: 'executed', undo: { actionId: 'restore_feature_flag' } });
    expect(flags.state.get('reports.heavy_export')).toBe(false);
    expect(await executor.execute(off, ctx)).toMatchObject({ status: 'executed', undo: null });
    expect((await executor.execute({ ...off, params: { flag: 'outra.flag', enabled: false } }, ctx)).status).toBe('failed');
  });

  it('DLQ: só reprocessa filas liberadas, com destino vindo da allowlist', async () => {
    const calls: unknown[][] = [];
    const dlq: DlqPort = { replay: async (...args) => (calls.push(args), 3) };
    const executor = new LiveExecutor(allowlist, { dlq });
    const replay = (queue: string) => ({ id: 'replay_dlq_batch', params: { queue, maxMessages: 10 }, reversible: false }) as const;
    const payments = { ...ctx, service: 'payments-events-go' };
    expect((await executor.execute(replay('payments.events.dlq'), payments)).status).toBe('executed');
    expect(calls).toEqual([['payments.events.dlq', 'payments.events', 10]]);
    expect((await executor.execute(replay('outra.dlq'), payments)).status).toBe('failed');
  });

  it('a allowlist versionada do repositório é válida e recusa namespace de sistema', async () => {
    const loaded = await loadExecutorTargets(`${ROOT}/config/executor-targets.yaml`);
    expect(loaded.kubernetes('kafka-telemetry', 'readings-enricher')).toEqual({ namespace: 'telemetry', deployment: 'readings-enricher' });
    expect(() =>
      ExecutorTargetsSchema.parse({ apiVersion: 'ops-copilot/v1', kind: 'ExecutorTargets', dlq: { svc: [{ queue: 'a.dlq', replayTo: 'a.dlq' }] } }),
    ).toThrow(/própria DLQ/);
    expect(() =>
      ExecutorTargetsSchema.parse({ apiVersion: 'ops-copilot/v1', kind: 'ExecutorTargets', kubernetes: { svc: { namespace: 'kube-system', deployments: ['x'] } } }),
    ).toThrow(/namespace de sistema/);
  });
});

describe('RedisDlqReplayer', () => {
  it('move até o limite e para quando a fila esvazia', async () => {
    const lists: Record<string, string[]> = { dlq: ['a', 'b', 'c'], main: [] };
    const moving = {
      lmove: async (from: string, to: string) => {
        const message = lists[from]?.shift() ?? null;
        if (message !== null) lists[to]?.push(message);
        return message;
      },
    };
    expect(await new RedisDlqReplayer(moving as never).replay('dlq', 'main', 2)).toBe(2);
    expect(lists.main).toEqual(['a', 'b']);
    expect(await new RedisDlqReplayer(moving as never).replay('dlq', 'main', 10)).toBe(1);
  });
});

describe('HttpFeatureFlagClient', () => {
  it('lê e grava com o token e valida o contrato da resposta', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = new HttpFeatureFlagClient({
      baseUrl: 'http://flags.test/',
      token: 'dev-only-flags-token',
      fetch: async (url, init) => {
        seen.push({ url, init });
        return init.method === 'GET' ? Response.json({ enabled: true }) : new Response(null, { status: 204 });
      },
    });
    expect(await client.isEnabled('reports.heavy_export')).toBe(true);
    await client.set('reports.heavy_export', false);
    expect(seen[1]?.url).toBe('http://flags.test/flags/reports.heavy_export');
    expect(seen[1]?.init.body).toBe('{"enabled":false}');
    expect((seen[1]?.init.headers as Record<string, string>)['Authorization']).toBe('Bearer dev-only-flags-token');

    const broken = new HttpFeatureFlagClient({ baseUrl: 'http://flags.test', token: 'dev-only-flags-token', fetch: async () => Response.json({ x: 1 }) });
    await expect(broken.isEnabled('f')).rejects.toThrow(/fora do contrato/);
  });
});

describe('KubernetesAdapter contra um emulador local da API', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  async function emulator() {
    const requests: { method: string; url: string; type: string; body: unknown }[] = [];
    let replicas: number | undefined = 3;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        requests.push({ method: req.method ?? '', url: req.url ?? '', type: req.headers['content-type'] ?? '', body: raw ? JSON.parse(raw) : null });
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'PATCH' && req.url?.endsWith('/scale')) {
          const ops = JSON.parse(raw) as { op: string; value: number }[];
          replicas = ops[1]?.value ?? replicas;
        }
        res.end(JSON.stringify({ apiVersion: 'autoscaling/v1', kind: 'Scale', spec: { replicas } }));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    // Configuração montada em memória: nada do kubeconfig ou dos contextos desta máquina é lido.
    const config = new KubeConfig();
    config.loadFromOptions({
      clusters: [{ name: 'emulador', server: `http://127.0.0.1:${String(port)}`, skipTLSVerify: true }],
      users: [{ name: 'teste', token: 'dev-only-kube-token' }],
      contexts: [{ name: 'teste', cluster: 'emulador', user: 'teste' }],
      currentContext: 'teste',
    });
    return { adapter: new KubernetesAdapter(config), requests, setMissing: () => (replicas = undefined) };
  }

  it('resposta sem spec.replicas é erro, nunca zero', async () => {
    const { adapter, setMissing } = await emulator();
    setMissing();
    await expect(adapter.replicas('saas', 'saas-api')).rejects.toThrow(/sem spec.replicas/);
  });

  it('lê o scale, escala com JSON Patch condicional e reinicia por anotação', async () => {
    const { adapter, requests } = await emulator();
    expect(await adapter.replicas('saas', 'saas-api')).toBe(3);
    await adapter.setReplicas('saas', 'saas-api', 3, 5);
    await adapter.restart('saas', 'saas-api', new Date('2026-11-20T12:00:00Z'));

    expect(requests[0]).toMatchObject({ method: 'GET', url: '/apis/apps/v1/namespaces/saas/deployments/saas-api/scale' });
    expect(requests[1]).toMatchObject({
      method: 'PATCH',
      type: 'application/json-patch+json',
      body: [
        { op: 'test', path: '/spec/replicas', value: 3 },
        { op: 'replace', path: '/spec/replicas', value: 5 },
      ],
    });
    expect(requests[2]).toMatchObject({ method: 'PATCH', url: '/apis/apps/v1/namespaces/saas/deployments/saas-api', type: 'application/strategic-merge-patch+json' });
    expect(JSON.stringify(requests[2]?.body)).toContain('"kubectl.kubernetes.io/restartedAt":"2026-11-20T12:00:00.000Z"');
  });
});
