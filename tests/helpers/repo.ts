// Acesso aos playbooks e à política versionados no repositório, e alertas de exemplo.
import { join } from 'node:path';
import { loadAutonomyPolicy, type AutonomyPolicy } from '../../src/autonomy/policy.js';
import type { Alert } from '../../src/domain/alert.js';
import { loadPlaybooks, type PlaybookRegistry } from '../../src/playbooks/registry.js';
import type { Playbook } from '../../src/playbooks/schema.js';

export const ROOT = join(import.meta.dirname, '..', '..');
export const PLAYBOOKS_DIR = join(ROOT, 'playbooks');
export const POLICY_FILE = join(ROOT, 'config', 'autonomy-policy.yaml');

export function alertFor(alertname: string, service: string, labels: Record<string, string> = {}): Alert {
  return {
    fingerprint: `fp-${alertname}`,
    alertname,
    service,
    severity: 'critical',
    startsAt: '2026-11-20T11:50:00Z',
    labels: { alertname, service, ...labels },
    annotations: { summary: `${alertname} disparou em ${service}` },
  };
}

export async function realPlaybooks(): Promise<PlaybookRegistry> {
  return loadPlaybooks(PLAYBOOKS_DIR);
}

export async function realPolicy(): Promise<AutonomyPolicy> {
  return loadAutonomyPolicy(POLICY_FILE);
}

export async function playbookById(id: string): Promise<Playbook> {
  const playbook = (await realPlaybooks()).all.find((candidate) => candidate.metadata.id === id);
  if (!playbook) throw new Error(`playbook ${id} não encontrado`);
  return playbook;
}
