import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const porta = (nome: string, padrao: number) => process.env[nome] ?? String(padrao);

export const URLS = {
  copiloto: `http://localhost:${porta('COPILOT_PORT', 8080)}`,
  prometheus: `http://localhost:${porta('PROMETHEUS_PORT', 9090)}`,
  alertmanager: `http://localhost:${porta('ALERTMANAGER_PORT', 9093)}`,
  jaeger: `http://localhost:${porta('JAEGER_UI_PORT', 16686)}`,
};

export const TOKENS = {
  webhook: process.env['WEBHOOK_TOKEN'] ?? 'dev-only-webhook-token-change-me',
  operador: process.env['OPERATOR_TOKEN'] ?? 'dev-only-operador-plantao',
};


const RAIZ = join(import.meta.dirname, '..', '..', '..');
const COMPOSE = ['compose', '-p', 'ops-copilot', '-f', 'docker-compose.yml', '-f', 'docker-compose.evidencia.yml'];

/** Roda `docker compose` do projeto ops-copilot e devolve stdout + stderr (o que o cartão mostra). */
export function compose(args: readonly string[]): string {
  return execFileSync('docker', [...COMPOSE, ...args], { cwd: RAIZ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function redisCli(...args: string[]): string {
  return compose(['--profile', 'core', 'exec', '-T', 'redis', 'redis-cli', ...args]);
}

export function awslocal(...args: string[]): string {
  return compose(['--profile', 'core', 'exec', '-T', 'localstack', 'awslocal', ...args]);
}
