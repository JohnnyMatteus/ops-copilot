# ADR 0003: Playbooks versionados em YAML, validados por schema

- **Status:** Aceito
- **Data:** 2026-11-21

## Contexto

O diagnóstico precisa de contexto do domínio: quais métricas olhar, quais causas são plausíveis e quais ações fazem sentido para cada causa. Esse conhecimento é dos times donos dos serviços (pagamentos, telemetria e agendamento), não do código do copiloto. Ele também muda com frequência e precisa de revisão.

## Decisão

Cada tipo de alerta tem um **playbook em YAML** em `playbooks/`, com `apiVersion`, `metadata.version` (semver) e `owner`. O schema Zod estrito (`src/playbooks/schema.ts`) valida:

- `match`: casamento exato por `alertname` + `service`;
- `signals`: consultas PromQL (instantâneas ou de intervalo) e buscas no Jaeger, com placeholders `{{rótulo}}` preenchidos só com rótulos do alerta;
- `diagnosis`: orientação e lista fechada de hipóteses;
- `actions`: ações do catálogo, cada uma ligada às hipóteses em que se aplica, com parâmetros fixos;
- `autonomy`: teto de nível e confiança mínima para execução automática.

Regras cruzadas (hipótese desconhecida em `when`, sinais ou ações duplicados, campos desconhecidos) também são erro. Um playbook inválido impede a subida do serviço e falha o CI (`pnpm validate:playbooks`).

## Consequências

- O time dono revisa o playbook num PR, como qualquer código, e o histórico do Git mostra quem mudou o quê.
- As hipóteses e ações do playbook viram enums fechados no schema da resposta do LLM: o modelo não consegue propor algo fora do playbook sem falhar na validação.
- Valores de rótulo são restritos a `[A-Za-z0-9_.:/-]`, o que impede injeção de PromQL a partir do Alertmanager.
- O YAML não expressa lógica condicional. Isso é proposital: a lógica fica no gate (código testado) e o playbook fica declarativo.

## Alternativas consideradas

- **Runbooks em Markdown com RAG:** mais fácil de escrever, mas não dá para validar nem extrair enums fechados. Fica como complemento futuro para a orientação (`guidance`).
- **Playbooks em TypeScript:** mais expressivos, mas exigiriam que os times donos mexessem no código do copiloto.
- **Casamento por similaridade de alerta:** mais tolerante a nomes novos, mas imprevisível. Casamento exato é auditável, e um alerta sem playbook é encaminhado a humanos (ADR 0009).
