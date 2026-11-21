# ADR 0009: Alerta sem playbook não é investigado pelo LLM

- **Status:** Aceito
- **Data:** 2026-11-21

## Contexto

Chegam alertas para os quais não existe playbook (um disco cheio, por exemplo). O copiloto poderia tentar diagnosticar "do zero" com o LLM.

## Decisão

Sem playbook casado, o grafo encerra em `triage` com `outcome: no_playbook`, registra `playbook_missing` na auditoria e não chama o LLM. O mesmo vale quando nenhum sinal pôde ser coletado (`insufficient_signals`).

## Consequências

- Sem playbook não há lista de hipóteses, de ações nem teto de autonomia, ou seja, nada contra o que o gate possa validar. Recusar é coerente com o ADR 0002.
- O custo com alertas desconhecidos é zero.
- A métrica `ops_copilot_incidents_total{outcome="no_playbook"}` mostra onde vale escrever o próximo playbook.
- O copiloto ajuda menos em incidentes novos. Um modo "somente leitura, sem ações" para alertas sem playbook pode vir depois, sem mudar esta regra para ações.

## Alternativas consideradas

- **Diagnóstico genérico com LLM:** útil como resumo, mas sem nenhuma ação possível. Fica como evolução opcional.
- **Playbook padrão "catch-all":** daria a falsa impressão de cobertura e, com o tempo, viraria lugar de ações genéricas perigosas.
