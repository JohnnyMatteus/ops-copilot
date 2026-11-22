# ADR 0015: Ações inversas e rollback pelo mesmo gate

- **Status:** Aceito
- **Data:** 2026-11-22

## Contexto

Ações reversíveis (`scale_deployment`, `toggle_feature_flag`) precisam de um caminho de volta que não abra uma porta nova: desfazer também é executar algo em produção.

## Decisão

- O catálogo declara a `inverse` de cada ação reversível. As inversas (`restore_deployment_replicas`, `restore_feature_flag`) são ações de catálogo com schema estrito e teto `execute_with_approval`.
- Inversas nunca vêm de uma proposta do diagnóstico: `evaluate` as bloqueia por código (`INVERSE_ACTION_IDS`, check `origem`), e os schemas de playbook e de política as recusam. A origem é definida pelo caminho de código, não por campo vindo do LLM.
- O caminho de rollback usa `evaluateRollback`, no mesmo módulo do gate: confere catálogo, que a inversa é a declarada para a ação original, a allowlist do serviço (da ação original), parâmetros, kill switch e nível. O veredito máximo é aprovação humana; nunca consome o orçamento automático.
- O executor guarda no resultado o `undo` com o estado anterior e o valor que ele próprio deixou (`expectedCurrent`). A restauração recusa se o valor atual for outro: ninguém tem mudança alheia sobrescrita.
- Cada rollback é auditado (executado, falho ou bloqueado) e só acontece uma vez por incidente.

## Consequências

- Rollback de `restart_pods` e `replay_dlq_batch` não existe (irreversíveis no catálogo).
- A flag é lida e depois gravada por HTTP, sem condição atômica; a janela de corrida é pequena e documentada.

## Alternativas consideradas

- **Inversa automática ao fim da janela:** esconderia decisões humanas e exigiria um temporizador confiável.
- **Rollback direto no executor, sem gate:** contornaria kill switch e allowlist.
