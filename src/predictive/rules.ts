// Regras de detecção preditiva (ADR 0020): consultas com `predict_linear` que abrem a investigação
// antes de o alerta do Alertmanager disparar. A regra só nomeia um alerta que já tem playbook; o
// diagnóstico, o gate e a execução são exatamente os do alerta real.
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import type { PlaybookRegistry } from '../playbooks/registry.js';

const duration = z.string().regex(/^\d+(m|h)$/, 'duração no formato 30m ou 1h');

export const PredictiveRuleSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  /** Alerta e serviço do playbook que será acionado. */
  alertname: z.string().min(1),
  service: z.string().min(1),
  summary: z.string().min(1),
  /** Valor previsto no horizonte; precisa usar `predict_linear` e devolver uma série por alvo. */
  predict: z.string().refine((query) => query.includes('predict_linear('), 'a consulta precisa usar predict_linear'),
  /** Valor atual, com os mesmos rótulos de `predict`: se já passou do limite, o alerta real cuida. */
  current: z.string().min(1),
  /** O limite é o mesmo do alerta real: previsto acima dele e atual abaixo dele. */
  threshold: z.number().finite(),
  /** Texto do horizonte usado na mensagem (a janela real está na consulta). */
  horizon: duration,
  /** Depois de abrir uma investigação, a mesma série não abre outra antes disto. */
  cooldown: duration.default('1h'),
});
export type PredictiveRule = z.infer<typeof PredictiveRuleSchema>;

export const PredictiveRulesSchema = z.strictObject({
  apiVersion: z.literal('ops-copilot/v1'),
  kind: z.literal('PredictiveRules'),
  rules: z.array(PredictiveRuleSchema).min(1),
});

export class PredictiveRulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PredictiveRulesError';
  }
}

export async function loadPredictiveRules(path: string, playbooks: PlaybookRegistry): Promise<readonly PredictiveRule[]> {
  const result = PredictiveRulesSchema.safeParse(parse(await readFile(path, 'utf8')));
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(raiz)'}: ${issue.message}`);
    throw new PredictiveRulesError(`${path}: regras preditivas inválidas\n${issues.join('\n')}`);
  }
  const names = result.data.rules.map((rule) => rule.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) throw new PredictiveRulesError(`${path}: regra duplicada: ${duplicate}`);
  for (const rule of result.data.rules) {
    if (!playbooks.match({ alertname: rule.alertname, service: rule.service })) {
      throw new PredictiveRulesError(`${path}: a regra ${rule.name} aponta para ${rule.alertname}@${rule.service}, que não tem playbook`);
    }
  }
  return result.data.rules;
}
