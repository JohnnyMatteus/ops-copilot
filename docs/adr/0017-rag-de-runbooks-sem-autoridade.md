# ADR 0017: RAG de runbooks Markdown sem autoridade

- **Status:** Aceito
- **Data:** 2026-11-22

## Contexto

A orientação do playbook é curta. As equipes já têm runbooks em Markdown com contexto útil ao diagnóstico, mas um texto recuperado e colocado no prompt é uma superfície de injeção: não pode ampliar o que o copiloto faz.

## Decisão

- `runbooks/*.md` com front matter validado por Zod (`title`, `playbooks`). A recuperação filtra pelo playbook em curso: nunca cruza playbooks.
- Recuperação lexical BM25 com MiniSearch, em memória, por seção `##`. Determinística, sem rede e sem embeddings; um embedding exigiria outro serviço de modelo e tornaria os testes não determinísticos.
- Os trechos (até 3, 700 caracteres cada) entram no prompt entre `<runbook>`, tratados como dado de terceiros, com a tag de fechamento removida do conteúdo. O prompt diz que não concedem permissão.
- Autoridade zero por construção: o schema do diagnóstico segue com enums fechados do playbook e toda ação passa pelo gate. Um teste prova que um runbook hostil que manda executar `reset_consumer_offsets` termina em `blocked`.
- A auditoria registra os ids dos trechos usados em `diagnosis_completed`.
- `pnpm validate:playbooks` valida os runbooks e que citam playbooks existentes. `RUNBOOKS_DIR` vazio desliga o RAG.

## Consequências

- A qualidade depende de palavras em comum entre alerta, sinais e runbook; sinônimos não casam. Embeddings ficam como evolução.
- O índice é carregado na subida; mudar um runbook exige reiniciar.

## Alternativas consideradas

- **Embeddings e banco vetorial:** melhor recall, mas dependência externa e custo; sem ganho comprovado para três playbooks.
- **Colar o runbook inteiro no prompt:** custo imprevisível e mais superfície de injeção.
