# ADR 0016: Papéis leitor e aprovador e teto de custo de LLM por incidente

- **Status:** Aceito
- **Data:** 2026-11-22
- **Complementa:** ADR 0012 e ADR 0013

## Contexto

Até aqui qualquer operador autenticado decidia, cancelava e, depois do ADR 0015, revertia ações. Quem só acompanha incidentes não deveria poder mexer em produção. Além disso, um modelo pago em loop de retry não pode gastar sem limite num único incidente.

## Decisão

- Dois papéis: `reader` (consulta) e `approver` (também aprova, recusa, cancela e reverte). O papel vem da credencial, nunca do corpo da requisição.
- Token de desenvolvimento: `email=token` é leitor; `email=token:approver` é aprovador. OIDC: o papel de `OIDC_APPROVER_ROLE` (padrão `ops-copilot-approver`) nos claims `roles` ou `realm_access.roles` concede aprovador; sem ele, leitor.
- A checagem existe nos serviços de domínio (`ApprovalService`, `RollbackService`) e a API responde 403. O painel esconde os controles para leitores, mas a autoridade é do servidor.
- O webhook do Alertmanager continua com o token próprio, fora dos papéis.
- Teto de custo: `LLM_MAX_COST_USD_PER_INCIDENT` (padrão US$ 0,25). `CostCappedLlmClient` soma o custo de cada resposta por incidente e recusa a chamada seguinte ao atingir o teto. Custo não informado pelo provedor falha fechado na chamada seguinte, porque somar desconhecido como zero mentiria. O estouro vira `diagnosis_failed` auditado (`reason: cost_ceiling`), com o uso conservado, e o incidente vai para humanos.

## Consequências

- Ambientes existentes precisam marcar quem aprova com `:approver`; sem isso todos viram leitores (falha para o lado seguro).
- Com OpenRouter sem campo de custo, o retry de schema fica bloqueado depois da primeira chamada.
- O teto é por incidente, não por período; um orçamento diário em dólares fica fora do escopo.

## Alternativas consideradas

- **Papel por serviço:** mais granular, mas sem demanda hoje; a política de autonomia já restringe por serviço.
- **Teto em tokens:** independe do provedor informar custo, mas não traduz o gasto real.
