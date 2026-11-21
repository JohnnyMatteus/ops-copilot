# ADR 0012: Autenticação de operador por token de dev ou OIDC

- **Status:** Aceito
- **Data:** 2026-11-21

## Contexto

Aprovar, recusar e cancelar mudam o que o copiloto faz em produção, e a trilha de auditoria precisa dizer **quem** decidiu. Até aqui havia um único `APPROVAL_TOKEN` compartilhado e o corpo da requisição trazia `"approver": e-mail`: qualquer um com o token podia assinar como qualquer pessoa. O painel (front-end Vigília) também precisa de um login.

## Decisão

- A identidade vem **da credencial, nunca do corpo**. `POST /approvals/:id` e `POST /incidents/:id/cancel` rejeitam campos extras (`approver` vira 400) e assinam a trilha com `human:<e-mail do operador>`.
- Porta `OperatorAuthenticator` (`src/auth/operator.ts`) com dois adaptadores, combinados por `ChainAuthenticator`:
  - **Token de dev** (`OPERATOR_TOKENS=email=token,...`): um token por pessoa, comparado por SHA-256 em tempo constante. Serve ao ambiente local e ao `make up`; o painel tem um campo "token" no login.
  - **OIDC opcional** (`OIDC_ISSUER_URL`): access token JWT validado com `jose` contra o JWKS do emissor (Keycloak do platform-edge), conferindo emissor, audiência (`OIDC_AUDIENCE`), expiração e a claim `email`. O painel faz o login com `oidc-client-ts` (Authorization Code + PKCE, cliente público `OIDC_CLIENT_ID`).
- `WEBHOOK_TOKEN` continua separado: ele autentica o Alertmanager, não pessoas, e nenhum token de operador pode ser igual a ele (validado na subida).
- Rotas públicas: `/healthz`, `/metrics` e `GET /config` (modo de execução e como entrar). Todo o resto exige operador.
- Papéis por enquanto são um só: todo operador autenticado pode aprovar. Separar "leitor" de "aprovador" é evolução.

## Consequências

- A auditoria prova quem decidiu, sem depender de a pessoa digitar o próprio e-mail.
- Tokens de dev ficam em variável de ambiente; não servem para produção. Em produção usa-se OIDC, e o copiloto não guarda segredo de usuário.
- O painel guarda o token em `sessionStorage` (some ao fechar a aba) e envia `Authorization: Bearer`; não há cookie, então não há CSRF.
- Não há revogação de token de dev além de trocar a variável e reiniciar.

## Alternativas consideradas

- **Sessão com cookie no próprio copiloto:** exigiria armazenar sessão, CSRF e logout; o bearer sem estado atende e mantém o OIDC como caminho único para produção.
- **Só OIDC:** exigiria subir um Keycloak para qualquer demonstração; o token de dev mantém `make up` autônomo.
