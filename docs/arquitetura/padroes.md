# Padrões e SOLID no ops-copilot

Só o que o código tem hoje. Cada item aponta o trecho, o problema que resolve e o custo.

## Arquitetura: portas e adaptadores

O domínio (gate, grafo, casos de uso) depende de interfaces. Os adaptadores concretos são escolhidos num único lugar, a raiz de composição [`src/app.ts#L29`](../../src/app.ts#L29).

| Porta | Adaptadores |
| --- | --- |
| [`LlmClient`](../../src/llm/client.ts#L23) | OpenAI compatível (Ollama, OpenRouter), [`ScriptedLlmClient`](../../src/llm/scripted.ts#L12), `FakeLlmClient` (testes) |
| [`MetricsSource` / `TraceSource`](../../src/signals/types.ts#L36) | Prometheus, Jaeger, fixtures |
| [`ApprovalAnnouncer` / `NotifierPort`](../../src/chatops/slack-client.ts) | `SlackClient` |
| [`ReplayGuard`](../../src/chatops/signature.ts) | Redis (`SET NX`), em memória |
| [`RunbookRetriever`](../../src/rag/runbooks.ts) | MiniSearch (BM25) em memória |
| [`InvestigationJournal`](../../src/incident/journal.ts), [`EffectGuard`](../../src/incident/effects.ts) | Redis (lease com dono, `SET NX`), em memória |
| `BaseCheckpointSaver` (LangGraph) | [`RedisCheckpointSaver`](../../src/graph/redis-checkpointer.ts), `MemorySaver` |
| [`ObjectStore`](../../src/storage/object-store.ts#L3) | S3 (LocalStack/AWS), em memória |
| [`AuditLog`](../../src/autonomy/audit.ts#L40) | S3 com object lock, arquivo JSONL, em memória |
| [`ActionBudget`](../../src/autonomy/budget.ts#L7) | [Redis](../../src/autonomy/redis-budget.ts#L15), [em memória](../../src/autonomy/budget.ts#L13) |
| [`ApprovalQueue`](../../src/incident/approvals.ts#L18) | [Redis](../../src/incident/redis-approvals.ts#L14), [em memória](../../src/incident/approvals.ts#L35) |
| [`IncidentRepository`](../../src/incident/incidents.ts#L4) | [Redis](../../src/incident/redis-incidents.ts#L9), em memória |
| [`ActionExecutor`](../../src/executor/executor.ts) | `DryRunExecutor`, [`LiveExecutor`](../../src/executor/live.ts) (portas `KubernetesPort`, `FeatureFlagPort`, `DlqPort`) |

- **Problema:** testar o grafo e o gate sem LLM, Prometheus, S3 ou Redis; trocar provedor sem tocar no domínio.
- **Trade-off:** mais arquivos e uma indireção a cada borda. Os adaptadores Redis e S3 só são cobertos pelos testes de integração (`make test-integration`).

Casos de uso explícitos: [`Investigator.investigate`](../../src/incident/investigator.ts#L44) (investigar alerta) e [`ApprovalService`](../../src/incident/approval-service.ts#L16) (resolver aprovação).

## Padrões

### Repository
[`IncidentRepository`](../../src/incident/incidents.ts#L4) e [`ApprovalQueue`](../../src/incident/approvals.ts#L18) escondem como o estado é guardado (chaves, TTL, sorted sets).
- **Resolve:** o caso de uso salva e lê relatórios e pedidos sem saber de Redis; `GETDEL` ([`redis-approvals.ts#L38`](../../src/incident/redis-approvals.ts#L38)) garante uso único dentro do adaptador.
- **Trade-off:** a consulta é limitada ao que a interface expõe (sem filtros por serviço hoje).

### Strategy
O executor ([`ActionExecutor`](../../src/executor/executor.ts#L22)) e o cliente LLM ([`LlmClient`](../../src/llm/client.ts#L23)) são estratégias intercambiáveis escolhidas por configuração (`EXECUTION_MODE`, `LLM_PROVIDER`).
- **Resolve:** dry-run, modelo roteirizado e provedores reais sem `if` espalhado pelo grafo.
- **Trade-off:** hoje há uma única estratégia de executor; o modo live falha na subida até ter adaptadores.

### Factory
[`createLlmClient`](../../src/llm/factory.ts#L7), [`createExecutor`](../../src/executor/executor.ts#L51), [`createAuditLog`](../../src/app.ts#L125) e [`createStateAdapters`](../../src/app.ts#L104).
- **Resolve:** a decisão "qual adaptador" fica num lugar; `createExecutor` recusa `live` explicitamente em vez de degradar para dry-run.
- **Trade-off:** a lista de opções vive em dois lugares (enum do `env.ts` e a factory).

### Decorator
[`InstrumentedLlmClient`](../../src/telemetry/instrumented-llm.ts#L8) implementa `LlmClient` e envolve outro `LlmClient` com span e métricas de tokens/custo. [`instrument`](../../src/graph/graph.ts#L19) faz o mesmo para cada etapa do grafo (span, histograma, registro da etapa percorrida).
- **Resolve:** observabilidade sem misturar telemetria com a lógica do diagnóstico ou das etapas.
- **Trade-off:** a ordem dos decoradores importa e não é verificada pelo tipo.

### Decorator (teto de custo)
[`CostCappedLlmClient`](../../src/llm/cost-cap.ts) envolve um `LlmClient` por incidente e recusa a chamada seguinte ao atingir o teto; custo desconhecido falha fechado.
- **Resolve:** o limite de gasto é código, fora do prompt e fora do nó de diagnóstico.
- **Trade-off:** com provedor que não informa custo, o retry de schema fica bloqueado.

### Allowlist deny-by-default
[`TargetAllowlist`](../../src/executor/targets.ts) e as inversas do [`catálogo`](../../src/autonomy/catalog.ts) (`INVERSE_ACTION_IDS`) dizem onde o executor pode agir e o que só o rollback executa, independentemente do gate.
- **Resolve:** duas camadas: o gate decide "pode", a allowlist decide "onde".
- **Trade-off:** mais um arquivo versionado para manter em dia com os playbooks.

### Lease com heartbeat e barreira idempotente
O diário de investigações usa lease com dono renovado por heartbeat; `act` ainda reserva o efeito por incidente (`SET NX`, nunca devolvida).
- **Resolve:** nenhuma investigação viva é retomada e, mesmo com o lease burlado, o efeito acontece uma vez.
- **Trade-off:** na dúvida o incidente termina `interrupted`, para verificação humana.

### Template Method
[`ChainedAuditLog`](../../src/autonomy/audit.ts#L64) implementa o encadeamento por hash e a serialização das escritas; as subclasses só fornecem [`write`](../../src/autonomy/audit.ts#L98) e `records` (memória, JSONL, [S3](../../src/autonomy/audit.ts#L170)).
- **Resolve:** a regra que garante a integridade da trilha existe uma vez só.
- **Trade-off:** herança acopla as subclasses à classe base; mudar o algoritmo afeta os três destinos.

### Especificação como dado (política e catálogo)
A política ([`config/autonomy-policy.yaml`](../../config/autonomy-policy.yaml)) e o [`ACTION_CATALOG`](../../src/autonomy/catalog.ts#L18) são dados validados por Zod; a função pura [`evaluate`](../../src/autonomy/gate.ts#L48) aplica as regras numa ordem fixa.
- **Resolve:** mudar o que o copiloto pode fazer é um PR em YAML, e a função pura é testável sem dublês.
- **Trade-off:** não é o padrão Specification com objetos combináveis; é uma sequência de guardas. Bom para seis ações e três serviços; com muitas políticas, OPA/Rego (ADR 0002).

Padrões que o código **não** usa: Outbox (não há banco transacional), Chain of Responsibility (o gate é uma função com guardas, não uma cadeia de handlers).

## SOLID

| Princípio | Onde | O que ganha | Custo |
| --- | --- | --- | --- |
| **S** responsabilidade única | [`evaluate`](../../src/autonomy/gate.ts#L48) só decide; [`AutonomyGate.decide`](../../src/autonomy/gate.ts#L121) só orquestra política e orçamento; [`RedisActionBudget`](../../src/autonomy/redis-budget.ts#L15) só conta | Cada peça muda por um motivo e tem teste próprio | Mais classes pequenas para seguir |
| **O** aberto/fechado | Novo destino de auditoria = nova subclasse de [`ChainedAuditLog`](../../src/autonomy/audit.ts#L64); novo provedor LLM = novo adaptador + linha na [factory](../../src/llm/factory.ts#L7) | Estender sem mexer no gate nem no grafo | Ação nova ainda exige editar o catálogo (decisão consciente: revisão em PR) |
| **L** substituição de Liskov | [`InMemoryActionBudget`](../../src/autonomy/budget.ts#L13) e [`RedisActionBudget`](../../src/autonomy/redis-budget.ts#L15) cumprem o mesmo contrato de consumo atômico; os testes do gate usam um e a produção o outro | Testes unitários valem para produção | O teste de integração precisa provar a atomicidade do Redis separadamente |
| **I** segregação de interfaces | [`ObjectStore`](../../src/storage/object-store.ts#L3) tem só `putIfAbsent`, `list` e `get` (sem delete); [`ActionBudget`](../../src/autonomy/budget.ts#L7) tem dois métodos | O adaptador não oferece o que a regra proíbe (apagar auditoria) | Interfaces pequenas multiplicam tipos |
| **D** inversão de dependência | [`InvestigationDeps`](../../src/graph/deps.ts#L13) só conhece portas; `ioredis` e o SDK da AWS só aparecem nos adaptadores (`redis-*.ts`, `s3-object-store.ts`), ligados em [`app.ts`](../../src/app.ts#L104) | Gate, grafo e casos de uso sem dependência de infraestrutura | A raiz de composição concentra muito conhecimento |
