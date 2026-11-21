// CLI dos evals. `pnpm eval` usa o modelo falso (CI); `pnpm eval --model real` usa o LLM do ambiente.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { z } from 'zod';
import { loadAutonomyPolicy } from '../src/autonomy/policy.js';
import { loadLlmEnv } from '../src/config/env.js';
import type { LlmClient } from '../src/llm/client.js';
import { FakeLlmClient } from '../src/llm/fake.js';
import { OpenAiCompatibleClient } from '../src/llm/openai-compatible.js';
import { loadPlaybooks } from '../src/playbooks/registry.js';
import { formatReport, loadDataset, runEvals } from './harness.js';

const ROOT = join(import.meta.dirname, '..');

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'fake' },
    'min-accuracy': { type: 'string', default: '0.8' },
    out: { type: 'string' },
  },
});

const mode = z.enum(['fake', 'real']).parse(values.model);
const minAccuracy = z.coerce.number().min(0).max(1).parse(values['min-accuracy']);

let model = 'fake-model';
let llmFor: (caseId: string) => LlmClient;
if (mode === 'fake') {
  const responses = z
    .record(z.string(), z.array(z.string()))
    .parse(parse(await readFile(join(ROOT, 'evals/fake-model/responses.yaml'), 'utf8')));
  llmFor = (caseId) => new FakeLlmClient(responses[caseId] ?? []);
} else {
  const env = loadLlmEnv();
  model = env.LLM_MODEL;
  const client = new OpenAiCompatibleClient({ provider: env.LLM_PROVIDER, baseUrl: env.LLM_BASE_URL, apiKey: env.OPENROUTER_API_KEY });
  llmFor = () => client;
}

const report = await runEvals({
  cases: await loadDataset(join(ROOT, 'evals/dataset/incidents.yaml')),
  playbooks: await loadPlaybooks(join(ROOT, 'playbooks')),
  policy: await loadAutonomyPolicy(join(ROOT, 'config/autonomy-policy.yaml')),
  model,
  llmFor,
});

console.log(formatReport(report));
if (values.out) {
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, JSON.stringify(report, null, 2));
  console.log(`\nRelatório salvo em ${values.out}`);
}

const { hypothesisAccuracy, outcomeAccuracy } = report.metrics;
if (hypothesisAccuracy < minAccuracy || outcomeAccuracy < minAccuracy) {
  console.error(`\nAbaixo do mínimo de ${(minAccuracy * 100).toFixed(0)}% em hipótese ou desfecho.`);
  process.exit(1);
}
