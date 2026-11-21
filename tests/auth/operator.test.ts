import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  ChainAuthenticator,
  OidcAuthenticator,
  parseOperatorTokens,
  StaticTokenAuthenticator,
} from '../../src/auth/operator.js';

const ISSUER = 'http://keycloak.local/realms/platform';

describe('tokens de operador', () => {
  it('lê e-mail=token separados por vírgula', () => {
    const tokens = parseOperatorTokens('a@example.com=aaaaaaaaaaaaaaaa, b@example.com=bbbbbbbbbbbbbbbb');
    expect([...tokens.keys()]).toEqual(['a@example.com', 'b@example.com']);
  });

  it('identifica o operador pelo token e recusa token desconhecido', async () => {
    const auth = new StaticTokenAuthenticator(parseOperatorTokens('a@example.com=aaaaaaaaaaaaaaaa,b@example.com=bbbbbbbbbbbbbbbb'));
    expect(await auth.authenticate('bbbbbbbbbbbbbbbb')).toEqual({ email: 'b@example.com', name: 'b', via: 'token' });
    expect(await auth.authenticate('cccccccccccccccc')).toBeNull();
    expect(await auth.authenticate('')).toBeNull();
  });
});

describe('OIDC', () => {
  async function setup() {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'k1' };
    const authenticator = new OidcAuthenticator({ issuer: ISSUER, audience: 'ops-copilot', keys: createLocalJWKSet({ keys: [jwk] }) });
    const sign = (claims: Record<string, unknown>, overrides: { issuer?: string; audience?: string; expires?: string } = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(overrides.issuer ?? ISSUER)
        .setAudience(overrides.audience ?? 'ops-copilot')
        .setExpirationTime(overrides.expires ?? '5m')
        .sign(privateKey);
    return { authenticator, sign };
  }

  it('aceita access token válido e extrai e-mail e nome', async () => {
    const { authenticator, sign } = await setup();
    const token = await sign({ email: 'lider@example.com', name: 'Líder de Plantão' });
    expect(await authenticator.authenticate(token)).toEqual({ email: 'lider@example.com', name: 'Líder de Plantão', via: 'oidc' });
  });

  it('recusa emissor, audiência, expiração e claims inválidos', async () => {
    const { authenticator, sign } = await setup();
    expect(await authenticator.authenticate(await sign({ email: 'a@example.com' }, { issuer: 'http://outro' }))).toBeNull();
    expect(await authenticator.authenticate(await sign({ email: 'a@example.com' }, { audience: 'outra-api' }))).toBeNull();
    expect(await authenticator.authenticate(await sign({ email: 'a@example.com' }, { expires: '-1m' }))).toBeNull();
    expect(await authenticator.authenticate(await sign({ sub: 'sem-email' }))).toBeNull();
    expect(await authenticator.authenticate('nao.e.jwt-valido')).toBeNull();
  });

  it('a cadeia aceita token estático e JWT', async () => {
    const { authenticator, sign } = await setup();
    const chain = new ChainAuthenticator([new StaticTokenAuthenticator(parseOperatorTokens('a@example.com=aaaaaaaaaaaaaaaa')), authenticator]);
    expect((await chain.authenticate('aaaaaaaaaaaaaaaa'))?.via).toBe('token');
    expect((await chain.authenticate(await sign({ email: 'b@example.com' })))?.via).toBe('oidc');
    expect(await chain.authenticate('x')).toBeNull();
  });
});
