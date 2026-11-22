# ADR 0014: Executor real com allowlist determinística de alvos

- **Status:** Aceito
- **Data:** 2026-11-22
- **Substitui em parte:** ADR 0006 (o dry-run continua sendo o padrão)

## Contexto

O ADR 0006 deixou o modo live para depois dos adaptadores reais. Agora existem adaptadores para Kubernetes (cliente oficial), feature flags e reprocesso de DLQ, atrás da mesma porta `ActionExecutor`.

## Decisão

- `EXECUTION_MODE=dry-run` segue como padrão. `live` só sobe com `EXECUTOR_TARGETS_FILE` e ao menos um backend configurado explicitamente (`KUBE_AUTH`, `FEATURE_FLAGS_URL`+`FEATURE_FLAGS_TOKEN`, `DLQ_REDIS_URL`). Faltando algo, a subida falha com erro que cita a variável.
- Kubernetes: `KUBE_AUTH=in-cluster` ou `kubeconfig` com `KUBECONFIG_PATH` e `KUBE_CONTEXT` obrigatórios. O copiloto nunca lê o kubeconfig padrão da máquina.
- Além do gate, o executor confere o alvo contra `config/executor-targets.yaml`: serviço → namespace e deployments, flags e DLQs (com a fila de destino). Tudo que não está listado é recusado; namespaces de sistema são rejeitados pelo schema.
- Escala usa JSON Patch com `test` do valor lido: se outra pessoa mudou as réplicas no meio, o servidor recusa. O teto `maxReplicas` do catálogo é aplicado no executor.
- Backend ausente vira falha explícita (`failed`), nunca sucesso simulado.
- `ExecutionResult.undo` guarda a ação inversa com o estado anterior (ADR 0015).

## Consequências

- Duas camadas independentes: o gate decide se pode agir; a allowlist decide onde.
- Adaptadores testados contra dublês e contra um emulador HTTP local da API do Kubernetes. Não foram exercitados contra cluster, serviço de flags ou Redis de DLQ reais.
- O contrato esperado do serviço de flags (`GET/PUT /flags/{flag}`, `{"enabled": bool}`) é uma suposição documentada.

## Alternativas consideradas

- **Allowlist só no gate/playbook:** o LLM e o playbook poderiam apontar para um namespace qualquer.
- **kubectl por subprocesso:** sem tipagem, sem teste por emulador e com shell no caminho.
