// Carrega, valida e indexa os playbooks. Qualquer arquivo inválido impede a subida (falha rápida).
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Alert } from '../domain/alert.js';
import { PlaybookSchema, TEMPLATE_PLACEHOLDER, type Playbook } from './schema.js';

export class PlaybookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookValidationError';
  }
}

export class PlaybookRegistry {
  readonly #byMatch = new Map<string, Playbook>();

  constructor(playbooks: readonly Playbook[]) {
    const ids = new Set<string>();
    for (const playbook of playbooks) {
      if (ids.has(playbook.metadata.id)) {
        throw new PlaybookValidationError(`Playbook duplicado: ${playbook.metadata.id}.`);
      }
      ids.add(playbook.metadata.id);
      const key = matchKey(playbook.match.alertname, playbook.match.service);
      const existing = this.#byMatch.get(key);
      if (existing) {
        throw new PlaybookValidationError(
          `Playbooks ${existing.metadata.id} e ${playbook.metadata.id} casam com o mesmo alerta (${key}).`,
        );
      }
      this.#byMatch.set(key, playbook);
    }
  }

  /** Casamento exato por alertname + service: previsível e auditável, sem similaridade. */
  match(alert: Pick<Alert, 'alertname' | 'service'>): Playbook | undefined {
    return this.#byMatch.get(matchKey(alert.alertname, alert.service));
  }

  get all(): readonly Playbook[] {
    return [...this.#byMatch.values()];
  }
}

function matchKey(alertname: string, service: string): string {
  return `${alertname}@${service}`;
}

/** Valida um documento YAML de playbook; o erro cita o arquivo e cada problema encontrado. */
export function parsePlaybook(source: string, origin: string): Playbook {
  let document: unknown;
  try {
    document = parse(source);
  } catch (error) {
    throw new PlaybookValidationError(`${origin}: YAML inválido (${(error as Error).message}).`);
  }
  const result = PlaybookSchema.safeParse(document);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(raiz)'}: ${issue.message}`);
    throw new PlaybookValidationError(`${origin}: playbook inválido\n${issues.join('\n')}`);
  }
  return result.data;
}

export async function loadPlaybooks(directory: string): Promise<PlaybookRegistry> {
  const files = (await readdir(directory)).filter((file) => /\.ya?ml$/.test(file)).sort();
  if (files.length === 0) {
    throw new PlaybookValidationError(`Nenhum playbook encontrado em ${directory}.`);
  }
  const playbooks = await Promise.all(
    files.map(async (file) => parsePlaybook(await readFile(join(directory, file), 'utf8'), file)),
  );
  return new PlaybookRegistry(playbooks);
}

/** Valores de rótulo aceitos dentro de consultas. Bloqueia aspas, chaves e operadores de PromQL. */
const SAFE_LABEL_VALUE = /^[A-Za-z0-9_.:/-]{1,128}$/;

/**
 * Substitui `{{label}}` pelos rótulos do alerta. Rótulo ausente ou com caracteres fora da lista
 * é erro: rótulos vêm de fora (Alertmanager) e não podem injetar PromQL.
 */
export function renderTemplate(template: string, labels: Readonly<Record<string, string>>): string {
  return template.replace(TEMPLATE_PLACEHOLDER, (_match, name: string) => {
    const value = labels[name];
    if (value === undefined) {
      throw new PlaybookValidationError(`Rótulo "${name}" ausente no alerta.`);
    }
    if (!SAFE_LABEL_VALUE.test(value)) {
      throw new PlaybookValidationError(`Rótulo "${name}" contém caracteres não permitidos em consultas.`);
    }
    return value;
  });
}
