// Modelo roteirizado para demonstrações sem LLM real (LLM_PROVIDER=scripted): devolve a resposta
// fixada para o playbook citado no prompt. Determinístico; a resposta ainda passa pelo schema do
// playbook e pelo gate, como a de um modelo de verdade.
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { LlmHttpError, type ChatRequest, type ChatResponse, type LlmClient } from './client.js';

const ScriptSchema = z.record(z.string().min(1), z.string().min(1));
const PLAYBOOK_LINE = /^Playbook (\S+) v/m;

export class ScriptedLlmClient implements LlmClient {
  readonly #byPlaybook: ReadonlyMap<string, string>;

  constructor(byPlaybook: Readonly<Record<string, string>>) {
    this.#byPlaybook = new Map(Object.entries(byPlaybook));
  }

  static async fromFile(path: string): Promise<ScriptedLlmClient> {
    return new ScriptedLlmClient(ScriptSchema.parse(parse(await readFile(path, 'utf8'))));
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const prompt = request.messages.map((message) => message.content).join('\n');
    const playbookId = PLAYBOOK_LINE.exec(prompt)?.[1];
    const content = playbookId ? this.#byPlaybook.get(playbookId) : undefined;
    if (!content) throw new LlmHttpError(`Modelo roteirizado sem resposta para o playbook ${playbookId ?? '(nenhum)'}.`);
    return { content, model: 'scripted', inputTokens: Math.ceil(prompt.length / 4), outputTokens: Math.ceil(content.length / 4), costUsd: 0 };
  }
}
