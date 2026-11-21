# ADR 0007: Trilha de auditoria append-only encadeada por hash

- **Status:** Aceito
- **Data:** 2026-11-21

## Contexto

Para cada incidente é preciso responder: o que o copiloto viu, o que concluiu, o que decidiu, por quê, e quem autorizou. Também é preciso perceber se alguém editou ou apagou registros depois.

## Decisão

Uma porta `AuditLog` com registros validados por Zod: `seq`, `at`, `incidentId`, `event` (de uma lista fechada), `actor` (`copilot` ou `human:<e-mail>`), `details`, `prevHash` e `hash`. O hash é SHA-256 do registro em JSON canônico (chaves ordenadas), e cada registro aponta para o hash do anterior. `verifyChain` detecta alteração, remoção ou reordenação. As escritas passam por uma fila interna, então a ordem gravada é a ordem dos eventos.

Implementações: em memória (testes), arquivo JSONL (desenvolvimento) e armazenamento de objetos com object lock (ADR 0010).

## Consequências

- A cadeia revela adulteração, mas não a impede. A imutabilidade de fato vem do armazenamento (ADR 0010).
- Registros não guardam prompts nem respostas completas do LLM, só decisões e motivos. Isso reduz o risco de dados sensíveis na trilha.
- A verificação é linear no número de registros. Para volumes grandes, o próximo passo é ancorar o hash a cada lote (checkpoint).

## Alternativas consideradas

- **Só logs estruturados:** já existem, mas logs são amostrados, rotacionados e editáveis.
- **Banco relacional com tabela de auditoria:** consultas melhores, mas mais infraestrutura e sem garantia contra `UPDATE`.
- **Assinatura digital por registro:** garante autoria, mas exige gestão de chaves. A cadeia de hash cobre a integridade com custo zero.
