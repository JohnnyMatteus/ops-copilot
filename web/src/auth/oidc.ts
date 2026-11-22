// Login OIDC (Authorization Code + PKCE) com oidc-client-ts, só quando o copiloto informa um emissor.
import { UserManager, WebStorageStateStore } from 'oidc-client-ts';
import type { PublicConfig } from '@/api/schemas';

export function createUserManager(oidc: NonNullable<PublicConfig['oidc']>): UserManager {
  return new UserManager({
    authority: oidc.issuer,
    client_id: oidc.clientId,
    redirect_uri: `${window.location.origin}/callback`,
    post_logout_redirect_uri: window.location.origin,
    response_type: 'code',
    scope: 'openid profile email',
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  });
}
