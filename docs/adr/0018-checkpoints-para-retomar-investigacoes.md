# ADR 0018: Checkpoints do LangGraph para retomar investigações

- **Status:** Aceito
- **Data:** 2026-11-22

## Contexto

Se o processo cai no meio de uma investigação, o incidente some: o alerta já foi aceito e o Alertmanager só repete depois do `repeat_interval`. Reexecutar tudo repete chamadas pagas de LLM e, pior, pode repetir uma ação.

## Decisão

- O grafo é compilado com um checkpointer e cada incidente é uma thread (`thread_id` = id do incidente). Sem Redis o checkpointer é o `MemorySaver`; com `REDIS_URL`, o `RedisCheckpointSaver` (cache `MemorySaver` com escrita no Redis, TTL de 24 h) deixa outro processo ler o estado.
- Um diário (`InvestigationJournal`, Redis) registra alerta e hora de início ao começar e remove a entrada quando o relatório é salvo. Quem executa uma investigação, inclusive `investigate`, toma um **lease com dono** (`SET NX PX`, token aleatório) e o renova por heartbeat (a cada um terço da validade, `INVESTIGATION_LEASE_SECONDS`, 30 s) enquanto roda; renovar e liberar conferem o dono (Lua). Só um lease expirado ou liberado permite a retomada, então uma investigação viva, mesmo lenta e no mesmo processo, nunca é retomada. A retomada roda na subida e a cada minuto.
- Última barreira, independente do lease: antes de executar uma ação ou abrir um pedido de aprovação, `act` faz uma reserva atômica de efeito por incidente (`EffectGuard`, `SET NX`, nunca devolvida). Quem perde a reserva, ou não consegue consultá-la, não age e termina como `interrupted` sem sobrescrever o relatório de quem agiu.
- Cada entrada é isolada: falha em uma não bloqueia as outras. Depois de 3 tentativas de retomada falhas, a investigação termina como `interrupted`, auditada, e sai do diário.
- A retomada continua da próxima etapa com `invoke(null)`, relendo o Redis (a leitura do "último" checkpoint nunca usa cache). Coleta e diagnóstico já feitos não se repetem.
- Efeito colateral nunca é repetido: se a próxima etapa é `act`, só é repetida quando seguramente sem efeito (veredito `blocked` ou `suggest`, ou `needs_approval` sem pedido na fila nem na trilha). Execução automática, ou pedido já aberto, termina como `interrupted` com mensagem para verificação manual. Auditoria: `investigation_resumed` e `investigation_interrupted`.
- Thread concluída é removida do Redis.

## Consequências

- Etapa em curso na queda é refeita: `decide` pode consumir o orçamento duas vezes (falha para o lado seguro) e `diagnose` paga outra chamada, limitada pelo teto do ADR 0016.
- Se o processo vivo ficar parado além da validade do lease (pausa longa de GC ou de rede), outro pode retomar a thread; a reserva de efeito impede o efeito duplicado, mas o diagnóstico pode ser repetido.
- A reserva de efeito é conservadora: uma queda entre reservar e agir deixa o incidente como `interrupted`, para verificação humana.
- O saver custom depende de campos internos do `MemorySaver` (`storage`, `writes`); testado contra um dublê de Redis, não contra um Redis real.

## Alternativas consideradas

- **`@langchain/langgraph-checkpoint-redis`:** exige o módulo RediSearch; o Redis do compose é o padrão.
- **Fila durável de alertas:** resolveria mais, mas é outra peça de infraestrutura.
