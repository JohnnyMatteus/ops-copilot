// RAG de runbooks Markdown (ADR 0017). Recuperação lexical (BM25, MiniSearch), local e determinística:
// só enriquece o prompt do diagnóstico. Um trecho recuperado é texto de referência, nunca autoriza ação;
// permissão continua exclusivamente no gate.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import MiniSearch from 'minisearch';
import { parse } from 'yaml';
import { z } from 'zod';

export const RunbookFrontMatterSchema = z.strictObject({
  title: z.string().min(1),
  /** Playbooks para os quais o runbook vale: a recuperação nunca cruza playbooks. */
  playbooks: z.array(z.string().min(1)).min(1),
});

export interface RunbookPassage {
  /** `arquivo.md#secao`, citado na auditoria. */
  readonly id: string;
  readonly runbook: string;
  readonly heading: string;
  readonly text: string;
}

export interface RunbookRetriever {
  search(input: { readonly playbookId: string; readonly query: string; readonly limit: number }): readonly RunbookPassage[];
}

export class RunbookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunbookValidationError';
  }
}

const MAX_PASSAGE_CHARS = 700;

interface IndexedPassage extends RunbookPassage {
  readonly playbooks: readonly string[];
}

/** Divide o Markdown em trechos por seção `##`, validando o front matter. */
export function parseRunbook(source: string, file: string): IndexedPassage[] {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  if (!match?.[1] || match[2] === undefined) throw new RunbookValidationError(`${file}: front matter ausente.`);
  const meta = RunbookFrontMatterSchema.safeParse(parse(match[1]));
  if (!meta.success) {
    const issues = meta.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new RunbookValidationError(`${file}: front matter inválido (${issues.join('; ')}).`);
  }
  const passages: IndexedPassage[] = [];
  for (const section of match[2].split(/^## /m).slice(1)) {
    const [heading = '', ...body] = section.split('\n');
    const text = body.join('\n').trim().replace(/\s+/g, ' ').slice(0, MAX_PASSAGE_CHARS);
    if (text) {
      passages.push({ id: `${file}#${heading.trim()}`, runbook: meta.data.title, heading: heading.trim(), text, playbooks: meta.data.playbooks });
    }
  }
  if (passages.length === 0) throw new RunbookValidationError(`${file}: nenhuma seção "## " com conteúdo.`);
  return passages;
}

export class MiniSearchRunbookRetriever implements RunbookRetriever {
  readonly #index: MiniSearch<IndexedPassage>;
  readonly #passages: readonly IndexedPassage[];

  constructor(passages: readonly IndexedPassage[]) {
    this.#passages = passages;
    this.#index = new MiniSearch<IndexedPassage>({
      fields: ['heading', 'text'],
      storeFields: ['id'],
      searchOptions: { boost: { heading: 2 }, prefix: true, fuzzy: false, combineWith: 'OR' },
      processTerm: (term) => (term.length < 3 ? null : term.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')),
    });
    this.#index.addAll(passages);
  }

  get size(): number {
    return this.#passages.length;
  }

  /** Playbooks citados pelos runbooks, para a validação cruzada. */
  get referencedPlaybooks(): ReadonlySet<string> {
    return new Set(this.#passages.flatMap((passage) => passage.playbooks));
  }

  search({ playbookId, query, limit }: { playbookId: string; query: string; limit: number }): readonly RunbookPassage[] {
    return this.#index
      .search(query, { filter: (result) => this.#passages.find((p) => p.id === result['id'])?.playbooks.includes(playbookId) ?? false })
      .slice(0, limit)
      .flatMap((hit) => {
        const passage = this.#passages.find((candidate) => candidate.id === hit.id);
        return passage ? [{ id: passage.id, runbook: passage.runbook, heading: passage.heading, text: passage.text }] : [];
      });
  }
}

export async function loadRunbooks(directory: string): Promise<MiniSearchRunbookRetriever> {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.md')).sort();
  const passages = (await Promise.all(files.map(async (file) => parseRunbook(await readFile(join(directory, file), 'utf8'), file)))).flat();
  const ids = passages.map((passage) => passage.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new RunbookValidationError(`Seção duplicada: ${duplicate}.`);
  return new MiniSearchRunbookRetriever(passages);
}
