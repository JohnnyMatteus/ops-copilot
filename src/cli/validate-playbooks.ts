// Valida playbooks e política de autonomia sem subir o serviço. Roda no CI.
import { loadAutonomyPolicy } from '../autonomy/policy.js';
import { loadPlaybooks } from '../playbooks/registry.js';
import { loadPredictiveRules } from '../predictive/rules.js';
import { loadRunbooks } from '../rag/runbooks.js';

const playbooksDir = process.argv[2] ?? 'playbooks';
const policyFile = process.argv[3] ?? 'config/autonomy-policy.yaml';
const runbooksDir = process.argv[4] ?? 'runbooks';
const predictiveFile = process.argv[5] ?? 'config/predictive-rules.yaml';

try {
  const [registry] = await Promise.all([loadPlaybooks(playbooksDir), loadAutonomyPolicy(policyFile)]);
  for (const playbook of registry.all) {
    console.log(`ok  ${playbook.metadata.id}@${playbook.metadata.version}  (${playbook.match.alertname} em ${playbook.match.service})`);
  }
  console.log(`ok  ${policyFile}`);
  const runbooks = await loadRunbooks(runbooksDir);
  const known = new Set(registry.all.map((playbook) => playbook.metadata.id));
  const unknown = [...runbooks.referencedPlaybooks].filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`${runbooksDir}: runbook cita playbook inexistente: ${unknown.join(', ')}`);
  const predictive = await loadPredictiveRules(predictiveFile, registry);
  console.log(`ok  ${predictiveFile}  (${String(predictive.length)} regras)`);
  console.log(`ok  ${runbooksDir}  (${String(runbooks.size)} trechos)`);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
