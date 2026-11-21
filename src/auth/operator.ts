// Identidade de quem opera o copiloto (ADR 0012). A identidade vem da credencial, nunca do corpo da
// requisição: é ela que assina aprovações, recusas e cancelamentos na trilha de auditoria.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

export interface Operator {
  readonly email: string;
  readonly name: string;
  readonly via: 'token' | 'oidc';
}

export interface OperatorAuthenticator {
  /** `null` quando a credencial não pertence a nenhum operador. */
  authenticate(bearer: string): Promise<Operator | null>;
}

const EmailSchema = z.email();

/** Formato de OPERATOR_TOKENS: `email=token` separados por vírgula. */
export function parseOperatorTokens(raw: string): ReadonlyMap<string, string> {
  const entries = raw
    .split(',')
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '')
    .map((pair) => {
      const separator = pair.indexOf('=');
      const email = pair.slice(0, separator).trim();
      const token = pair.slice(separator + 1).trim();
      if (separator <= 0 || !EmailSchema.safeParse(email).success) throw new Error('cada item precisa ser e-mail=token');
      if (token.length < 16) throw new Error('cada token precisa de pelo menos 16 caracteres');
      return [email, token] as const;
    });
  return new Map(entries);
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Um token por operador, para o ambiente local. Compara os SHA-256 em tempo constante: os digests
 * têm sempre o mesmo tamanho, então nem o comprimento do token vaza.
 */
export class StaticTokenAuthenticator implements OperatorAuthenticator {
  readonly #operators: readonly { email: string; digest: Buffer }[];

  constructor(tokens: ReadonlyMap<string, string>) {
    this.#operators = [...tokens].map(([email, token]) => ({ email, digest: digest(token) }));
  }

  async authenticate(bearer: string): Promise<Operator | null> {
    const provided = digest(bearer);
    let match: string | null = null;
    for (const operator of this.#operators) {
      if (timingSafeEqual(provided, operator.digest)) match = operator.email;
    }
    return match ? { email: match, name: match.split('@')[0] ?? match, via: 'token' } : null;
  }
}

export interface OidcOptions {
  readonly issuer: string;
  readonly audience: string;
  /** Keycloak publica as chaves em `<issuer>/protocol/openid-connect/certs`. */
  readonly jwksUrl?: string | undefined;
  readonly keys?: JWTVerifyGetKey;
}

const OidcClaimsSchema = z.object({
  email: z.email(),
  name: z.string().optional(),
  preferred_username: z.string().optional(),
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
      const { email, name, preferred_username: username } = claims.data;
      return { email, name: name ?? username ?? email, via: 'oidc' };
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
