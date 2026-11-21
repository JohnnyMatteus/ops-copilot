# ADR 0005: Saída do LLM validada por Zod, com um retry e depois erro explícito

- **Status:** Aceito
- **Data:** 2026-11-21

## Contexto

O diagnóstico vira entrada do gate. Texto mal formado, uma hipótese inventada ou evidência que cita um sinal que nem foi coletado não podem seguir adiante como se fossem válidos.

## Decisão

`generateStructured` (`src/llm/structured.ts`) faz a chamada com temperatura 0, extrai o JSON (aceita bloco ```json), valida com Zod e, se falhar, faz **um único retry** mostrando ao modelo a própria resposta e a lista de problemas. Se continuar inválido, lança `LlmOutputValidationError` com os problemas e o uso acumulado (tokens e custo das duas chamadas).

O schema é montado por playbook (`src/incident/diagnosis.ts`):

- `hypothesisId` é um enum das hipóteses do playbook;
- `evidence[].signal` é um enum **só dos sinais coletados com sucesso**;
- `proposedAction.actionId` é um enum das ações do playbook, ou `null`.

O nó `diagnose` converte o erro em `outcome: diagnosis_failed`, registrado na auditoria, e o incidente vai para humanos sem decisão.

## Consequências

- Falha de formato vira erro explícito e auditado, nunca uma ação baseada em texto ambíguo.
- O custo de uma resposta ruim fica limitado a duas chamadas.
- Citar um sinal indisponível força o retry: é uma checagem barata contra alucinação de evidência.
- Um retry a mais não corrige erro de raciocínio. Esse tipo de erro é medido pelos evals (ADR 0008).

## Alternativas consideradas

- **Function calling / structured outputs do provedor:** reduz falhas de formato, mas nem todo modelo do Ollama suporta. A validação Zod continua necessária de qualquer forma, porque enums dinâmicos e regras cruzadas são nossos.
- **Vários retries:** aumentam custo e latência com retorno decrescente.
- **Corrigir a resposta com heurísticas:** esconderia o problema e tornaria o comportamento imprevisível.
