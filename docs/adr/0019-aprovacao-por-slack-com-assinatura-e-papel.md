# ADR 0019: Aprovação por Slack com assinatura verificada, anti-replay e papel

- **Status:** Aceito
- **Data:** 2026-11-22

## Contexto

O plantão está no Slack, não no painel. Um botão que aprova ação em produção é uma porta nova: precisa provar que o clique veio do Slack, não ser reaproveitável e respeitar os papéis do ADR 0016.

## Decisão

- `POST /chatops/slack/interactions` só existe com `SLACK_SIGNING_SECRET`. A assinatura v0 (`HMAC-SHA256` de `v0:timestamp:corpo`) é conferida em tempo constante sobre o corpo bruto; carimbo fora de 5 minutos é recusado. Corpo inválido: 401, sem chegar ao handler.
- Anti-replay: a assinatura aceita é registrada (`SET NX` no Redis, memória sem Redis) pela janela de tolerância; a mesma requisição reenviada recebe 401. Retentativas legítimas do Slack caem nisso, e a aprovação já é de uso único.
- Identidade e papel: `SLACK_USERS` (`IDSlack=e-mail[:approver]`) mapeia usuário para operador. Fora do mapa, ou leitor, não decide; a negativa é auditada (`chatops_denied`). A decisão passa pelo mesmo `ApprovalService` (gate reavaliado, auditoria com o e-mail mapeado e `via: slack`).
- Ações com dinheiro (`payments-events-go`, `replay_dlq_batch`) não têm botão: a mesma regra do painel exige digitar o serviço, o que um botão não faz. A mensagem manda para o painel, e o servidor também recusa um clique forjado.
- Recusa por botão registra o motivo padrão "Recusado pelo Slack por <e-mail>".
- `SlackClient` (Web API `chat.postMessage`) publica o pedido com botões (`ApprovalAnnouncer`, chamado na etapa `act`; falha vira `chatops_notification_failed`, nunca derruba a investigação) e serve de `NotifierPort` para `notify_oncall` em modo live. `ok:false` é erro.

## Consequências

- Não foi exercitado contra um workspace Slack real: testes usam payloads de exemplo, o vetor de assinatura publicado na documentação do Slack e um dublê de `fetch`.
- O mapa de usuários é estático (variável de ambiente); um diretório (SCIM/OIDC) fica como evolução.
- Os botões não atualizam a mensagem original; a resposta é efêmera.

## Alternativas consideradas

- **Aprovar por comando `/aprovar <id>`:** mais fácil de forjar por engano e sem o contexto do pedido na tela.
- **Confiar no e-mail do perfil do Slack:** exigiria escopo extra e chamada à API; o mapa explícito é auditável.
