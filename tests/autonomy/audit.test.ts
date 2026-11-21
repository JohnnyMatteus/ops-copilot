import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileAuditLog, InMemoryAuditLog, verifyChain } from '../../src/autonomy/audit.js';

const entry = (incidentId: string) => ({
  incidentId,
  event: 'decision_made' as const,
  actor: 'copilot',
  details: { verdict: 'blocked', reasons: ['fora da allowlist'] },
});

describe('trilha de auditoria', () => {
  it('encadeia registros por hash e mantém a ordem mesmo com escritas concorrentes', async () => {
    const audit = new InMemoryAuditLog();
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => audit.append(entry(id))));
    const records = await audit.records();
    expect(records.map((record) => record.seq)).toEqual([0, 1, 2, 3]);
    expect(records[1]?.prevHash).toBe(records[0]?.hash);
    expect(verifyChain(records)).toEqual({ valid: true });
  });

  it('detecta adulteração de um registro', async () => {
    const audit = new InMemoryAuditLog();
    for (const id of ['a', 'b', 'c']) await audit.append(entry(id));
    const records = [...(await audit.records())];
    const second = records[1];
    if (!second) throw new Error('registro ausente');
    records[1] = { ...second, details: { verdict: 'auto_execute' } };
    expect(verifyChain(records)).toEqual({ valid: false, brokenAt: 1 });
  });

  it('detecta remoção de um registro', async () => {
    const audit = new InMemoryAuditLog();
    for (const id of ['a', 'b', 'c']) await audit.append(entry(id));
    const records = (await audit.records()).filter((record) => record.seq !== 1);
    expect(verifyChain(records).valid).toBe(false);
  });

  it('rejeita ator fora do formato copilot | human:<e-mail>', async () => {
    const audit = new InMemoryAuditLog();
    await expect(audit.append({ ...entry('a'), actor: 'alguém' })).rejects.toThrow();
  });

  it('persiste em JSONL e continua a cadeia depois de reabrir o arquivo', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'ops-copilot-audit-')), 'audit.jsonl');
    const first = new FileAuditLog(path);
    await first.append(entry('a'));
    await first.append(entry('b'));

    const reopened = new FileAuditLog(path);
    await reopened.append(entry('c'));
    const records = await reopened.records();
    expect(records).toHaveLength(3);
    expect(verifyChain(records)).toEqual({ valid: true });
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(3);
  });

  it('falha explicitamente se o arquivo tiver linha corrompida', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'ops-copilot-audit-')), 'audit.jsonl');
    await writeFile(path, '{"seq":0}\n');
    await expect(new FileAuditLog(path).append(entry('a'))).rejects.toThrow();
  });
});
