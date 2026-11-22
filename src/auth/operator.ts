// Identidade de quem opera o copiloto (ADR 0012). A identidade vem da credencial, nunca do corpo da
// requisição: é ela que assina aprovações, recusas e cancelamentos na trilha de auditoria.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

/** Papéis (ADR 0016): leitor só consulta; aprovador também decide, cancela e reverte. */
export type Role = 'reader' | 'approver';

export interface Operator {
  readonly email: string;
  readonly name: string;
  readonly via: 'token' | 'oidc' | 'slack';
  readonly role: Role;
}

export const canApprove = (operator: Pick<Operator, 'role'>): boolean => operator.role === 'approver';

export class ForbiddenError extends Error {
  constructor() {
    super('Esta ação exige o papel de aprovador.');
    this.name = 'ForbiddenError';
  }
}

export function requireApprover(operator: Pick<Operator, 'role'>): void {
  if (!canApprove(operator)) throw new ForbiddenError();
}

export interface OperatorCredential {
  readonly token: string;
  readonly role: Role;
}

export interface OperatorAuthenticator {
  /** `null` quando a credencial não pertence a nenhum operador. */
  authenticate(bearer: string): Promise<Operator | null>;
}

const EmailSchema = z.email();

/**
 * Formato de OPERATOR_TOKENS: `email=token` (leitor) ou `email=token:approver`, separados por vírgula.
 * Sem sufixo o papel é o de menor privilégio.
 */
export function parseOperatorTokens(raw: string): ReadonlyMap<string, OperatorCredential> {
  const entries = raw
    .split(',')
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '')
    .map((pair) => {
      const separator = pair.indexOf('=');
      const email = pair.slice(0, separator).trim();
      let token = pair.slice(separator + 1).trim();
      let role: Role = 'reader';
      const suffix = /:(reader|approver)$/.exec(token);
      if (suffix) {
        role = suffix[1] as Role;
        token = token.slice(0, suffix.index);
      }
      if (separator <= 0 || !EmailSchema.safeParse(email).success) throw new Error('cada item precisa ser e-mail=token');
      if (token.length < 16) throw new Error('cada token precisa de pelo menos 16 caracteres');
      return [email, { token, role }] as const;
    });
  return new Map(entries);
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Um token por operador, para o ambiente local. Compara os SHA-256 em tempo constante: os digests
 * têm sempre o mesmo tamanho, então nem o comprimento do token vaza.
 */
export class StaticTokenAuthenticator implements OperatorAuthenticator {
  readonly #operators: readonly { email: string; role: Role; digest: Buffer }[];

  constructor(tokens: ReadonlyMap<string, OperatorCredential>) {
    this.#operators = [...tokens].map(([email, { token, role }]) => ({ email, role, digest: digest(token) }));
  }

  async authenticate(bearer: string): Promise<Operator | null> {
    const provided = digest(bearer);
    let match: { email: string; role: Role } | null = null;
    for (const operator of this.#operators) {
      if (timingSafeEqual(provided, operator.digest)) match = operator;
    }
    return match ? { email: match.email, name: match.email.split('@')[0] ?? match.email, via: 'token', role: match.role } : null;
  }
}

export interface OidcOptions {
  readonly issuer: string;
  readonly audience: string;
  /** Keycloak publica as chaves em `<issuer>/protocol/openid-connect/certs`. */
  readonly jwksUrl?: string | undefined;
  readonly keys?: JWTVerifyGetKey;
  /** Papel do emissor que vira `approver`; qualquer outro token autenticado é leitor. */
  readonly approverRole?: string;
}

const OidcClaimsSchema = z.object({
  email: z.email(),
  name: z.string().optional(),
  preferred_username: z.string().optional(),
  roles: z.array(z.string()).optional(),
  realm_access: z.object({ roles: z.array(z.string()) }).optional(),
});

/** Access token JWT do Keycloak do platform-edge (ou de qualquer emissor OIDC). */
export class OidcAuthenticator implements OperatorAuthenticator {
  readonly #options: OidcOptions;
  readonly #keys: JWTVerifyGetKey;

  constructor(options: OidcOptions) {
    this.#options = options;
    this.#keys =
      options.keys ?? createRemoteJWKSet(new URL(options.jwksUrl ?? `${options.issuer}/protocol/openid-connect/certs`));
  }

  async authenticate(bearer: string): Promise<Operator | null> {
    if (bearer.split('.').length !== 3) return null;
    try {
      const { payload } = await jwtVerify(bearer, this.#keys, {
        issuer: this.#options.issuer,
        audience: this.#options.audience,
      });
      const claims = OidcClaimsSchema.safeParse(payload);
      if (!claims.success) return null;
      const { email, name, preferred_username: username, roles, realm_access: realm } = claims.data;
      const granted = [...(roles ?? []), ...(realm?.roles ?? [])];
      const role: Role = granted.includes(this.#options.approverRole ?? 'ops-copilot-approver') ? 'approver' : 'reader';
      return { email, name: name ?? username ?? email, via: 'oidc', role };
    } catch {
      return null;
    }
  }
}

/** Tenta cada adaptador na ordem; o primeiro que reconhece a credencial vence. */
export class ChainAuthenticator implements OperatorAuthenticator {
  readonly #chain: readonly OperatorAuthenticator[];

  constructor(chain: readonly OperatorAuthenticator[]) {
    this.#chain = chain;
  }

  async authenticate(bearer: string): Promise<Operator | null> {
    for (const authenticator of this.#chain) {
      const operator = await authenticator.authenticate(bearer);
      if (operator) return operator;
    }
    return null;
  }
}
