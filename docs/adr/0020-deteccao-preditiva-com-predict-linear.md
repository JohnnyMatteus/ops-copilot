# ADR 0020: Detecção preditiva com predict_linear

- **Status:** Aceito
- **Data:** 2026-11-22

## Contexto

O copiloto só age depois que o Alertmanager dispara. Para métricas com tendência clara (lag, backlog, latência), uma previsão linear curta dá ao plantão e ao copiloto uma janela antes da violação.

## Decisão

- `config/predictive-rules.yaml` (validado por Zod): cada regra traz a consulta `predict` (obrigatoriamente com `predict_linear`), a consulta `current`, o limite do alerta real, o horizonte e o cooldown, e aponta para um alerta que já tem playbook. Regra que aponta para playbook inexistente impede a subida; `pnpm validate:playbooks` confere no CI.
- O `PredictiveDetector` roda a cada `PREDICTIVE_INTERVAL_SECONDS` (60 s). Abre uma investigação quando o previsto passa do limite e o atual ainda não: se já passou, o alerta real cuida. A mesma série não reabre enquanto a previsão persiste nem dentro do cooldown. Falha de consulta vira métrica e log, sem derrubar o ciclo.
- O alerta sintético (severidade `warning`, rótulo `origin=predictive`, anotações `predicted: true` e valor previsto) entra no mesmo `Investigator`: mesmo playbook, mesmo gate, mesma política, mesma auditoria (`alert_received` registra `predicted`). Nada na previsão amplia poderes.
- O prompt avisa que, em alerta preditivo, os sinais ainda não violam o limite e a tendência é o que importa.
- Dataset de evals ampliado de 11 para 28 incidentes inventados: alertas preditivos, confiança baixa, ação fora do limite, ação fora da hipótese, injeção no alerta, saída sem schema, fontes fora do ar e alertas sem playbook; dois erros de hipótese plantados no modelo falso.

## Consequências

- A previsão é linear sobre 15 minutos: ruidosa em séries sazonais ou em degraus; o cooldown e o limite do alerta real limitam o ruído, mas falsos positivos abrem investigações (sem efeito além do que o gate já permite).
- As consultas só foram validadas em dublê; o Prometheus do compose tem séries sintéticas senoidais, onde a previsão dispara na subida do ciclo.
- Os evals com modelo falso medem o gate e o roteamento, não a qualidade de um modelo real.

## Alternativas consideradas

- **Regras de alerta `predict_linear` no Prometheus/Alertmanager:** simples, mas o aviso chegaria como alerta comum, sem a marca de previsão nem o cooldown por série.
- **Modelos de previsão sazonal:** melhores para ciclos, com dependência e dados históricos que não existem aqui.
