# ADR 0006: Executor de ações em dry-run por padrão

- **Status:** Aceito
- **Data:** 2026-11-21

## Contexto

Mesmo com o gate, a primeira fase de um copiloto de operações precisa ganhar confiança: comparar o que ele faria com o que o plantão fez, sem risco.

## Decisão

O `ActionExecutor` é uma porta. A única implementação da fundação é o `DryRunExecutor`, que descreve a ação com os parâmetros finais e quem autorizou, sem efeito colateral. `EXECUTION_MODE` tem padrão `dry-run`. Pedir `live` hoje faz a aplicação falhar na subida com `ExecutorConfigError`, em vez de cair em silêncio para dry-run. Falhas do executor viram `execution_failed` auditado.

## Consequências

- A trilha de auditoria e as métricas já registram "o que teria sido feito": é a base para medir acerto em produção antes de ligar a execução.
- Ligar o modo live exige implementar adaptadores (Kubernetes, feature flags, fila) atrás da mesma porta, com testes próprios. Isso está em "Próximos passos".
- Não há como esquecer o modo live ligado por engano numa configuração parcial.

## Alternativas consideradas

- **Executar de verdade desde o início com escopo pequeno:** demonstraria mais, mas exigiria um cluster e credenciais no ambiente local, sem ganho para a fundação.
- **Dry-run como flag por ação:** mais granular, porém mais fácil de configurar errado. Fica para quando houver adaptadores reais.
