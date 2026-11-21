import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parsePlaybook, PlaybookRegistry, PlaybookValidationError, renderTemplate } from '../../src/playbooks/registry.js';
import { PLAYBOOKS_DIR, realPlaybooks } from '../helpers/repo.js';

async function rawPlaybook(): Promise<Record<string, unknown>> {
  return parse(await readFile(join(PLAYBOOKS_DIR, 'saas-p99-latency.yaml'), 'utf8')) as Record<string, unknown>;
}

type Path = readonly (string | number)[];

function getPath(doc: unknown, path: Path): unknown {
  return path.reduce<unknown>((node, key) => (node as Record<string | number, unknown>)[key], doc);
}

/** Copia o playbook e troca um único campo, para testar cada regra do schema isoladamente. */
function withValue(doc: Record<string, unknown>, path: Path, value: unknown): string {
  const copy = structuredClone(doc);
  const parent = getPath(copy, path.slice(0, -1)) as Record<string | number, unknown>;
  parent[path.at(-1) as string | number] = value;
  return stringify(copy);
}

describe('playbooks versionados', () => {
  it('carrega os três playbooks do repositório e casa por alertname + service', async () => {
    const registry = await realPlaybooks();
    expect(registry.all.map((p) => p.metadata.id).sort()).toEqual([
      'payments-dlq-backlog',
      'saas-p99-latency',
      'telemetry-consumer-lag',
    ]);
    expect(registry.match({ alertname: 'PaymentsDlqBacklogHigh', service: 'payments-events-go' })?.metadata.id).toBe(
      'payments-dlq-backlog',
    );
  });

  it('não casa alerta com serviço diferente do playbook', async () => {
    const registry = await realPlaybooks();
    expect(registry.match({ alertname: 'PaymentsDlqBacklogHigh', service: 'saas-multitenant' })).toBeUndefined();
  });

  it('rejeita versão fora do formato semântico', async () => {
    const source = withValue(await rawPlaybook(), ['metadata', 'version'], 'v2');
    expect(() => parsePlaybook(source, 'x.yaml')).toThrow(/metadata\.version/);
  });

  it('rejeita ação fora do catálogo', async () => {
    const source = withValue(await rawPlaybook(), ['actions', 0, 'action'], 'drop_tables');
    expect(() => parsePlaybook(source, 'x.yaml')).toThrow(/actions\.0\.action/);
  });

  it('rejeita ação ligada a hipótese inexistente', async () => {
    const source = withValue(await rawPlaybook(), ['actions', 0, 'when'], ['hipotese_inventada']);
    expect(() => parsePlaybook(source, 'x.yaml')).toThrow(/hipótese desconhecida: hipotese_inventada/);
  });

  it('rejeita sinais com nome duplicado', async () => {
    const doc = await rawPlaybook();
    const source = withValue(doc, ['signals', 'metrics', 1, 'name'], getPath(doc, ['signals', 'metrics', 0, 'name']));
    expect(() => parsePlaybook(source, 'x.yaml')).toThrow(/sinal duplicado/);
  });

  it('rejeita campos desconhecidos (erro de digitação não passa em silêncio)', async () => {
    const source = withValue(await rawPlaybook(), ['autonomy', 'maxLevle'], 'auto_execute');
    expect(() => parsePlaybook(source, 'x.yaml')).toThrow(PlaybookValidationError);
  });

  it('rejeita YAML malformado citando o arquivo', () => {
    expect(() => parsePlaybook('a: [', 'quebrado.yaml')).toThrow(/quebrado\.yaml: YAML inválido/);
  });

  it('rejeita dois playbooks para o mesmo alerta', async () => {
    const [first] = (await realPlaybooks()).all;
    if (!first) throw new Error('sem playbooks');
    const clone = { ...first, metadata: { ...first.metadata, id: 'outro-id' } };
    expect(() => new PlaybookRegistry([first, clone])).toThrow(/casam com o mesmo alerta/);
  });
});

describe('renderTemplate', () => {
  it('substitui placeholders pelos rótulos do alerta', () => {
    expect(renderTemplate('x{service="{{service}}",q="{{ queue }}"}', { service: 'saas-multitenant', queue: 'a.b' })).toBe(
      'x{service="saas-multitenant",q="a.b"}',
    );
  });

  it('recusa rótulo ausente', () => {
    expect(() => renderTemplate('{{consumergroup}}', {})).toThrow(/ausente/);
  });

  it('recusa valor que tentaria injetar PromQL', () => {
    expect(() => renderTemplate('x{service="{{service}}"}', { service: 'a"} or vector(1) #' })).toThrow(/não permitidos/);
  });
});
