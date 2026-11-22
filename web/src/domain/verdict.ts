// Os quatro veredictos do gate têm cor, ícone e texto próprios: a cor nunca é o único sinal.
import { mdiCancel, mdiHandBackLeftOutline, mdiLightbulbOutline, mdiShieldCheckOutline } from '@mdi/js';
import type { Verdict } from '@/api/schemas';

export interface VerdictStyle {
  readonly label: string;
  readonly color: string;
  readonly icon: string;
}

export const VERDICT: Record<Verdict, VerdictStyle> = {
  auto_execute: { label: 'AUTO', color: 'verdict-auto', icon: mdiShieldCheckOutline },
  needs_approval: { label: 'APROVAÇÃO', color: 'verdict-approval', icon: mdiHandBackLeftOutline },
  suggest: { label: 'SUGESTÃO', color: 'verdict-suggest', icon: mdiLightbulbOutline },
  blocked: { label: 'BLOQUEADO', color: 'verdict-blocked', icon: mdiCancel },
};

export const VERDICT_LONG: Record<Verdict, string> = {
  auto_execute: 'executa sozinho, dentro de todos os limites',
  needs_approval: 'precisa de uma pessoa para decidir',
  suggest: 'só sugere: nada executa',
  blocked: 'bloqueado pelo gate',
};

export const LEVEL_LABEL = {
  read_only: 'somente leitura',
  suggest: 'sugerir',
  execute_with_approval: 'aprovação',
  auto_execute: 'automático',
} as const;

export const CHECK_LABEL: Record<string, string> = {
  catalogo: 'catálogo',
  allowlist: 'allowlist do serviço',
  playbook: 'prevista no playbook',
  hipotese: 'hipótese autoriza a ação',
  parametros: 'parâmetros dentro dos limites',
  kill_switch: 'kill switch',
  nivel: 'nível efetivo',
  reversivel: 'ação reversível',
  confianca: 'confiança mínima',
  orcamento: 'orçamento de ações automáticas',
};
