# ADR 0002: Limites de autonomia como código determinístico, nunca como prompt

- **Status:** Aceito
- **Data:** 2026-11-21

## Contexto

O copiloto pode propor ações com efeito real: escalar deployments, desligar feature flags, reprocessar a DLQ de pagamentos ou mover offsets no Kafka. Um LLM pode errar o diagnóstico, alucinar parâmetros ou obedecer a uma instrução injetada no texto do alerta. Uma regra escrita no prompt ("nunca reprocesse a DLQ sem aprovação") é uma sugestão ao modelo, não uma garantia.

## Decisão

Toda proposta do LLM passa por um **gate determinístico** (`src/autonomy/gate.ts`) antes de chegar ao executor. O gate não lê o prompt nem chama o modelo. Ele avalia, nesta ordem:

1. A ação existe no **catálogo** (`src/autonomy/catalog.ts`)?
2. Ela está na **allowlist** do serviço na política (`config/autonomy-policy.yaml`)?
3. Ela está prevista no **playbook** para a **hipótese** diagnosticada?
4. Os **parâmetros** passam no schema do catálogo, que tem limites (ex.: no máximo 2 réplicas a mais, até 500 mensagens)? Parâmetros fixados no playbook prevalecem sobre os do LLM.
5. O **nível efetivo** é o mais restritivo entre a política do serviço, o teto do playbook, o teto da ação e o kill switch.
6. No nível `auto_execute`, a ação só roda sozinha se for **reversível**, se a **confiança** atingir o mínimo do playbook e se houver **orçamento** na janela. Se faltar qualquer um, o gate rebaixa para aprovação humana.

Os níveis são `read_only`, `suggest`, `execute_with_approval` e `auto_execute`. Os vereditos são `blocked`, `suggest`, `needs_approval` e `auto_execute`. Na aprovação humana, o gate reavalia a proposta com a política vigente: a aprovação nunca contorna um bloqueio.

## Consequências

- As garantias não dependem do modelo. Os testes de `tests/autonomy/gate.test.ts` provam que ações fora do limite são bloqueadas, inclusive quando o modelo "obedece" a uma injeção (`tests/graph/investigation.test.ts`).
- Mudar o que o copiloto pode fazer sozinho é um PR em YAML, com revisão, e não um ajuste de prompt.
- Há mais código para manter: o catálogo precisa crescer junto com as ações, e cada ação nova precisa de schema de parâmetros e de classificação de reversibilidade.
- O orçamento ficava em memória e reiniciava com o processo. Desde o ADR 0011 ele fica no Redis, com consumo atômico.

## Alternativas consideradas

- **Regras no prompt:** zero código, mas sem garantia. Uma única resposta errada basta para executar algo indevido.
- **Um segundo LLM como juiz:** reduz erros, mas continua probabilístico e dobra custo e latência.
- **Motor de políticas externo (OPA/Rego):** bom para muitas equipes e políticas. Para seis ações e três serviços, a política em YAML com Zod é mais simples de ler e testar. Migrar para OPA continua possível, porque `evaluate` é uma função pura.
