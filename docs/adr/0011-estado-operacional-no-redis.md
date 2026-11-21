# ADR 0011: Orçamento, aprovações e incidentes no Redis

- **Status:** Aceito
- **Data:** 2026-11-21

## Contexto

O orçamento de ações automáticas e a fila de aprovações ficavam em memória (ADR 0002). Um restart apagava aprovações pendentes (o plantonista aprovava um id que já não existia) e zerava o orçamento: um copiloto que reinicia em loop podia executar o orçamento inteiro a cada subida. Duas réplicas também teriam saldos separados.

## Decisão

- Portas explícitas: `ActionBudget` (`src/autonomy/budget.ts`), `ApprovalQueue` (`src/incident/approvals.ts`) e `IncidentRepository` (`src/incident/incidents.ts`). Os adaptadores em memória continuam para testes e para `pnpm dev` sem Redis.
- Com `REDIS_URL`, a raiz de composição (`src/app.ts`) liga os adaptadores Redis:
  - **Orçamento:** um sorted set por serviço com o instante de cada execução. Um script Lua limpa a janela, conta e registra numa única operação; réplicas concorrentes não passam do limite.
  - **Aprovações:** um valor JSON por pedido e um sorted set pelo prazo. `GETDEL` retira o pedido atomicamente, então a mesma aprovação nunca executa duas vezes. O valor vive além do prazo para responder 410 (expirada) em vez de 404.
  - **Incidentes:** o relatório de cada investigação, com TTL de 7 dias, para `GET /incidents`.
- Redis `7.4.6-alpine` com AOF e `noeviction`: o estado sobrevive também a um restart do Redis, e falta de memória vira erro em vez de descarte silencioso.
- **Falha fechada:** se o Redis não responde, o gate trata o orçamento como indisponível e a ação passa a exigir aprovação humana. Nada executa sozinho sem saber o saldo.

## Consequências

- Aprovações pendentes e o saldo do orçamento sobrevivem a restart e são compartilhados entre réplicas.
- Mais uma dependência no ambiente. Na subida, o copiloto falha se o Redis não responde, em vez de começar sem estado.
- O gate ficou assíncrono (`decide` devolve `Promise`); `evaluate` continua uma função pura.
- A trilha de auditoria continua no S3 (ADR 0010). O Redis guarda estado operacional, não a prova do que aconteceu.

## Alternativas consideradas

- **Postgres:** daria durabilidade, mas o projeto não tem banco relacional, e TTL e operações atômicas de janela são nativas no Redis.
- **Checkpoints do LangGraph:** resolvem retomar investigações, não o orçamento compartilhado nem a fila de aprovações.
