// Valida playbooks e política de autonomia sem subir o serviço. Roda no CI.
import { loadAutonomyPolicy } from '../autonomy/policy.js';
import { loadPlaybooks } from '../playbooks/registry.js';

const playbooksDir = process.argv[2] ?? 'playbooks';
const policyFile = process.argv[3] ?? 'config/autonomy-policy.yaml';

try {
  const [registry] = await Promise.all([loadPlaybooks(playbooksDir), loadAutonomyPolicy(policyFile)]);
  for (const playbook of registry.all) {
    console.log(`ok  ${playbook.metadata.id}@${playbook.metadata.version}  (${playbook.match.alertname} em ${playbook.match.service})`);
  }
  console.log(`ok  ${policyFile}`);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
