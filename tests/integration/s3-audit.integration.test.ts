import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { ObjectStoreAuditLog, verifyChain } from '../../src/autonomy/audit.js';
import { ObjectAlreadyExistsError } from '../../src/storage/object-store.js';
import { S3ObjectStore } from '../../src/storage/s3-object-store.js';
import { ADMIN, AUDIT_BUCKET, S3_ENDPOINT, WRITER } from './env.js';

const client = (credentials: { accessKeyId: string; secretAccessKey: string }) =>
  new S3Client({ region: 'us-east-1', endpoint: S3_ENDPOINT, forcePathStyle: true, credentials });

const entry = (incidentId: string) => ({
  incidentId,
  event: 'decision_made' as const,
  actor: 'copilot',
  details: { verdict: 'auto_execute' },
});

describe('trilha de auditoria no MinIO com object lock', () => {
  const prefix = `it/${randomUUID()}/`;
  const store = new S3ObjectStore({ bucket: AUDIT_BUCKET, region: 'us-east-1', client: client(WRITER) });

  it('anexa registros encadeados e os relê na ordem', async () => {
    const audit = new ObjectStoreAuditLog(store, prefix);
    for (const id of ['a', 'b', 'c']) await audit.append(entry(id));
    const records = await new ObjectStoreAuditLog(store, prefix).records();
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(verifyChain(records)).toEqual({ valid: true });
  });

  it('recusa sobrescrever um registro existente', async () => {
    await expect(store.putIfAbsent(`${prefix}000000000000.json`, '{}')).rejects.toBeInstanceOf(ObjectAlreadyExistsError);
  });

  it('o usuário do copiloto não consegue apagar registros', async () => {
    await expect(
      client(WRITER).send(new DeleteObjectCommand({ Bucket: AUDIT_BUCKET, Key: `${prefix}000000000000.json` })),
    ).rejects.toThrow();
  });

  it('nem o administrador apaga uma versão retida sem contornar a governança', async () => {
    const admin = client(ADMIN);
    const versions = await admin.send(new ListObjectVersionsCommand({ Bucket: AUDIT_BUCKET, Prefix: `${prefix}000000000000.json` }));
    const versionId = versions.Versions?.[0]?.VersionId;
    expect(versionId).toBeDefined();
    await expect(
      admin.send(new DeleteObjectCommand({ Bucket: AUDIT_BUCKET, Key: `${prefix}000000000000.json`, VersionId: versionId })),
    ).rejects.toThrow();
  });
});
