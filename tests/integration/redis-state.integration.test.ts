import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { RedisActionBudget } from '../../src/autonomy/redis-budget.js';
import { RedisApprovalQueue } from '../../src/incident/redis-approvals.js';
import { playbookById } from '../helpers/repo.js';
import { REDIS_URL } from './env.js';

const redis = new Redis(REDIS_URL);
afterAll(() => redis.quit());

describe('estado operacional no Redis', () => {
  it('orçamento atômico: chamadas concorrentes não passam do limite', async () => {
    const budget = new RedisActionBudget(redis, { prefix: `it:${randomUUID()}:` });
    const results = await Promise.all(Array.from({ length: 10 }, () => budget.tryConsume('svc', 60_000, 3)));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await budget.remaining('svc', 60_000, 3)).toBe(0);
  });

  it('aprovação sobrevive a uma nova instância e é usada uma única vez', async () => {
    const prefix = `it:${randomUUID()}:approvals`;
    const pending = await new RedisApprovalQueue(redis, { ttlMs: 60_000, prefix }).request('inc-1', {
      service: 'payments-events-go',
      playbook: await playbookById('payments-dlq-backlog'),
      hypothesisId: 'downstream_recovered',
      confidence: 0.9,
      proposal: { actionId: 'replay_dlq_batch', params: { maxMessages: 50 } },
    });
    const restarted = new RedisApprovalQueue(redis, { ttlMs: 60_000, prefix });
    expect((await restarted.list()).map((a) => a.id)).toEqual([pending.id]);
    const [first, second] = await Promise.all([restarted.take(pending.id), restarted.take(pending.id)]);
    expect([first.status, second.status].sort()).toEqual(['found', 'not_found']);
  });

  it('aprovação vencida responde expirada, não inexistente', async () => {
    let now = 0;
    const queue = new RedisApprovalQueue(redis, { ttlMs: 1_000, prefix: `it:${randomUUID()}:approvals`, now: () => now });
    const pending = await queue.request('inc-2', {
      service: 'saas-multitenant',
      playbook: await playbookById('saas-p99-latency'),
      hypothesisId: 'noisy_tenant',
      confidence: 1,
      proposal: { actionId: 'notify_oncall', params: {} },
    });
    now = 5_000;
    expect(await queue.list()).toEqual([]);
    expect(await queue.take(pending.id)).toEqual({ status: 'expired' });
  });
});
