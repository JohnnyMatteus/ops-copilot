# ADR 0004: Cliente LLM próprio sobre a API compatível com OpenAI, com modelo falso nos testes

- **Status:** Aceito
- **Data:** 2026-11-21

## Contexto

O copiloto precisa trocar de modelo sem mudar código: um modelo local (Ollama) em desenvolvimento e um modelo hospedado (via OpenRouter) quando a qualidade importar. Nenhum teste pode chamar um LLM real, por custo, flakiness e porque o CI não tem segredos.

## Decisão

- Uma porta mínima `LlmClient.chat(request)` em `src/llm/client.ts`, sem `fetch` nem `process.env`.
- Um adaptador `OpenAiCompatibleClient` que fala `POST /chat/completions` com `response_format: json_object` e lê tokens e custo (`usage.cost` do OpenRouter). O Ollama tem custo zero; custo não informado vira `null`, nunca zero.
- Um `FakeLlmClient` com respostas roteirizadas: é o único cliente usado em testes e no eval do CI.
- Um decorador `InstrumentedLlmClient` adiciona spans `gen_ai.chat` e métricas de tokens e custo, sem que os nós saibam da telemetria.

## Consequências

- Trocar de modelo ou de provedor é configuração (`LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL`).
- Erros do provedor nunca incluem o corpo da resposta, que poderia ecoar o prompt ou a chave.
- Não usamos o `ChatOpenAI` do LangChain. Isso tira abstrações que não usamos (streaming, ferramentas), mas exige manter o adaptador. O padrão é o mesmo do agente de posicionamento.

## Alternativas consideradas

- **SDK oficial da OpenAI:** funciona com provedores compatíveis, mas adiciona uma dependência maior para uma única chamada HTTP.
- **`@langchain/openai`:** integração natural com LangGraph, porém esconde o formato do `usage`, de onde vem o custo.
- **Mocks de rede (msw/nock) nos testes:** testariam o adaptador, mas acoplariam cada teste de domínio ao formato HTTP. O adaptador tem testes próprios com `fetch` injetado.
