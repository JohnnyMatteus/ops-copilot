// Mapeamento de usuário do Slack para operador e papel (ADR 0019). Fora do mapa não existe: quem não
// está listado não decide nada. O papel segue as regras do ADR 0016.
import { z } from 'zod';
import type { Operator, Role } from '../auth/operator.js';

const EmailSchema = z.email();

/** Formato de SLACK_USERS: `U123=ana@example.com:approver,U456=bia@example.com` (sem sufixo, leitor). */
export function parseSlackUsers(raw: string): ReadonlyMap<string, Pick<Operator, 'email' | 'role'>> {
  const entries = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map((item) => {
      const separator = item.indexOf('=');
      const id = item.slice(0, separator).trim();
      let email = item.slice(separator + 1).trim();
      let role: Role = 'reader';
      const suffix = /:(reader|approver)$/.exec(email);
      if (suffix) {
        role = suffix[1] as Role;
        email = email.slice(0, suffix.index);
      }
      if (separator <= 0 || !/^[UW][A-Z0-9]{2,}$/.test(id) || !EmailSchema.safeParse(email).success) {
        throw new Error('cada item precisa ser IDSlack=e-mail[:approver], com ID no formato U123ABC');
      }
      return [id, { email, role }] as const;
    });
  return new Map(entries);
}

export function operatorFromSlack(users: ReadonlyMap<string, Pick<Operator, 'email' | 'role'>>, slackUserId: string): Operator | null {
  const known = users.get(slackUserId);
  return known ? { email: known.email, name: known.email.split('@')[0] ?? known.email, via: 'slack', role: known.role } : null;
}

/** Mesma regra do painel: ação com dinheiro exige digitar o serviço, o que um botão não faz. */
const MONEY_SERVICES = new Set(['payments-events-go']);
export const requiresPanelConfirmation = (service: string, action: string): boolean =>
  MONEY_SERVICES.has(service) || action === 'replay_dlq_batch';
