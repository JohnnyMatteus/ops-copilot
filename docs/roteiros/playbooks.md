# Roteiro: playbooks

Como explicar e defender, numa entrevista, como o ops-copilot transforma conhecimento operacional em algo que o LLM usa e o código valida.

## A ideia em uma frase

Um playbook é um **contrato versionado** entre o time dono do serviço e o copiloto. Ele define o que investigar, quais causas são plausíveis e quais ações fazem sentido para cada causa. Ele também vira o **schema** da resposta do LLM.

## Como funciona

Os playbooks ficam em `playbooks/*.yaml`, um por alerta, e são validados por um schema Zod estrito (`src/playbooks/schema.ts`):

- **`metadata`**: `id`, `version` em semver, `owner` (o time) e descrição.
- **`match`**: casamento exato por `alertname` + `service`. Dois playbooks para o mesmo alerta são erro.
- **`signals`**: consultas PromQL (instantâneas ou de intervalo) e buscas no Jaeger. `{{service}}` e `{{consumergroup}}` são preenchidos com rótulos do alerta, mas só se o valor casar com `[A-Za-z0-9_.:/-]{1,128}`. Sem isso, o Alertmanager viraria um vetor de injeção de PromQL.
- **`diagnosis`**: orientação em texto e uma lista **fechada** de hipóteses (no mínimo duas, para forçar o diagnóstico diferencial).
- **`actions`**: ações do catálogo, cada uma com `when` (as hipóteses em que se aplica), parâmetros fixos e justificativa.
- **`autonomy`**: teto de nível e confiança mínima para execução automática.

O que acontece em tempo de execução:

1. `triage` casa o alerta com o playbook.
2. `collect` renderiza as consultas e coleta tudo em paralelo; falhas viram sinais de erro.
3. `diagnose` gera o schema da resposta **a partir do playbook**: `hypothesisId` é um enum das hipóteses, `evidence[].signal` é um enum dos sinais coletados com sucesso e `actionId` é um enum das ações. Uma resposta fora disso falha e força o retry.
4. `decide` confere de novo, de forma independente, se a ação está no playbook para aquela hipótese, e aplica os parâmetros fixos.

Validação em três momentos: CI (`pnpm validate:playbooks`), subida do serviço (playbook inválido impede o start) e testes (`tests/playbooks/registry.test.ts`).

## Os três playbooks

| Playbook | Hipóteses | Ação por hipótese |
| --- | --- | --- |
| `payments-dlq-backlog` | dependência fora · dependência voltou · mensagem envenenada · consumidor saturado | só `downstream_recovered` libera `replay_dlq_batch`; saturação libera `scale_deployment`; o resto avisa o plantão |
| `telemetry-consumer-lag` | falta de réplicas · destino lento · registro envenenado · consumidor travado | `scale_deployment` só para falta de réplicas; `restart_pods` para travado; `reset_consumer_offsets` para envenenado (fora da allowlist do serviço: o gate bloqueia e o plantão decide) |
| `saas-p99-latency` | tenant barulhento · consulta lenta · CPU saturada | desligar `reports.heavy_export` só para tenant barulhento; escalar só para CPU |

A orientação codifica armadilhas reais. Exemplos: escalar o consumidor quando o destino está lento piora a pressão; escalar a API quando o pool do banco está saturado também piora; reprocessar a DLQ com a dependência ainda fora devolve tudo para a DLQ.

## Alternativas e trade-offs

| Alternativa | Por que não (por enquanto) |
| --- | --- |
| Runbooks em Markdown + RAG | Fácil de escrever, impossível de validar e de transformar em enums. Fica como complemento da orientação. |
| Playbooks em TypeScript | Mais expressivos, mas tiram dos times donos a autoria e misturam lógica com conhecimento. |
| Casamento por similaridade (embeddings) | Tolera nomes novos, mas é imprevisível e difícil de auditar. |
| Deixar o LLM escolher consultas (ReAct) | Flexível, mas o custo é imprevisível e as consultas podem ser caras ou erradas. |

Trade-offs assumidos:

- **Cobertura depende de escrever playbooks.** Alertas sem playbook vão para humanos (`no_playbook`), e a métrica mostra onde vale escrever o próximo.
- **YAML não tem lógica.** É proposital: a lógica fica no gate, que é testado.
- **Resumo em vez de série bruta.** O prompt recebe estatísticas (último, mínimo, máximo, variação, p50/p95 dos traces) de no máximo 5 séries por sinal. O custo fica previsível, mas o modelo perde detalhes finos.

## Perguntas que um entrevistador faria

**Por que YAML e não um banco ou uma UI?**
Porque playbook é código operacional: precisa de revisão, histórico, diff e rollback. Git e PR resolvem isso de graça. O schema estrito pega erro de digitação (`maxLevle`) antes de chegar em produção.

**Como o playbook impede o LLM de propor bobagem?**
De duas formas independentes. Na validação, hipóteses, sinais e ações viram enums fechados, então resposta fora deles falha e força o retry. Na decisão, o gate confere de novo se a ação está no playbook para aquela hipótese. Se um dia o schema for afrouxado, o gate continua segurando.

**Por que exigir pelo menos duas hipóteses?**
Para obrigar diagnóstico diferencial. Com uma hipótese só, o modelo apenas confirmaria. Os casos interessantes estão justamente em separar causas parecidas: lag por falta de réplicas ou por destino lento.

**Como versionar um playbook sem quebrar incidentes em andamento?**
O incidente guarda o `id` e a `version` do playbook na auditoria (`playbook_matched`). A aprovação pendente guarda o playbook que foi usado na proposta. A mudança de versão entra por PR, roda os evals e passa a valer no próximo deploy.

**E se o rótulo do alerta vier com algo como `"} or vector(1)`?**
`renderTemplate` recusa: o valor não casa com a lista de caracteres permitidos. O sinal vira erro do tipo `template` e a consulta não sai. Há teste para isso.

**Como saber se um playbook novo é bom?**
Adicionando casos ao dataset de evals (`evals/dataset/incidents.yaml`) e rodando `pnpm eval --model real`. O harness mede acerto de hipótese, de ação e de desfecho com o grafo real.

**Quem escreve os playbooks?**
O time dono do serviço (`metadata.owner`), com revisão de quem cuida do copiloto quando a mudança mexe em ações ou autonomia. O template de PR pede o incremento de versão e o resultado dos evals.

**Como isso escala para 50 serviços?**
O casamento é O(1) por chave. O gargalo é humano: escrever playbooks. Os próximos passos seriam playbooks parametrizados por classe de serviço (ex.: "consumidor Kafka") e RAG sobre runbooks para a orientação, mantendo hipóteses e ações fechadas.
