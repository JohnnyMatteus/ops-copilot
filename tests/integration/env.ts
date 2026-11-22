// Endereços dos serviços do compose vistos do host. Portas seguem as variáveis do .env.example.
const port = (name: string, fallback: number) => process.env[name] ?? String(fallback);

export const PROMETHEUS_URL = process.env['IT_PROMETHEUS_URL'] ?? `http://localhost:${port('PROMETHEUS_PORT', 9090)}`;
export const JAEGER_URL = process.env['IT_JAEGER_URL'] ?? `http://localhost:${port('JAEGER_UI_PORT', 16686)}`;
export const S3_ENDPOINT = process.env['IT_S3_ENDPOINT'] ?? `http://localhost:${port('S3_PORT', 4566)}`;
export const AUDIT_BUCKET = process.env['AUDIT_S3_BUCKET'] ?? 'ops-copilot-audit';
export const WRITER = {
  accessKeyId: process.env['AUDIT_WRITER_ACCESS_KEY'] ?? 'audit-writer',
  secretAccessKey: process.env['AUDIT_WRITER_SECRET_KEY'] ?? 'dev-only-audit-writer-change-me',
};
export const ADMIN = {
  accessKeyId: process.env['S3_ADMIN_ACCESS_KEY'] ?? 'dev-only-s3-admin',
  secretAccessKey: process.env['S3_ADMIN_SECRET_KEY'] ?? 'dev-only-s3-admin-secret',
};
export const REDIS_URL = process.env['IT_REDIS_URL'] ?? `redis://localhost:${port('REDIS_PORT', 6379)}`;
