# ADR 0008: Evals com dataset sintético, modelo falso no CI e modelo real sob demanda

- **Status:** Aceito
- **Data:** 2026-11-21

## Contexto

Testes unitários provam que o gate e o grafo funcionam. Não provam que o diagnóstico é bom. Medir o acerto exige um conjunto de incidentes com resposta esperada. O CI não pode chamar um LLM real.

## Decisão

- **Dataset** em `evals/dataset/incidents.yaml`: incidentes sintéticos com alerta, sinais e o que um SRE concluiria (`hypothesisId`, `actionId` e `outcome`). Cobre os três serviços e um alerta sem playbook.
- **Harness** em `evals/harness.ts`: roda o grafo de produção (playbooks, política e gate reais) trocando só o LLM. Mede acerto de hipótese, de ação e de desfecho, taxa de retry, falhas de diagnóstico, tokens e custo.
- **CI**: `pnpm eval` usa respostas roteirizadas (`evals/fake-model/responses.yaml`), com um erro e um retry plantados de propósito, e falha abaixo de 80%. Isso testa o harness e as regras de ponta a ponta.
- **Modelo real**: `pnpm eval --model real` localmente, ou o workflow manual `eval-real.yml` (`workflow_dispatch`) com o segredo do OpenRouter.

## Consequências

- Mudanças em playbook, prompt ou gate têm uma régua objetiva. O acerto de desfecho também captura regressões do gate.
- O resultado com o modelo falso não diz nada sobre a qualidade do modelo. Ele só garante que a régua funciona. A qualidade é medida no modo real.
- Onze casos são poucos para conclusões estatísticas. Ampliar o dataset com incidentes reais anonimizados é um próximo passo.

## Alternativas consideradas

- **LLM como juiz:** útil para texto livre (resumo), desnecessário para saídas categóricas como hipótese e ação.
- **Rodar o modelo real no CI a cada PR:** custo recorrente, segredo exposto a PRs e resultado não determinístico.
