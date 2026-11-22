# CLAUDE.md: ops-copilot

Guia para sessões de agente neste repositório.

## Visão

Copiloto de operações (AI-Ops) que investiga alertas de `payments-events-go`, `kafka-telemetry` e `saas-multitenant` (serviços fictícios do portfólio), diagnostica com LLM guiado por playbooks e propõe ações. **Limites de autonomia são código determinístico, nunca prompt** (ADR 0002). Leia `docs/design-doc.md` antes de mudanças estruturais.

## Regras inegociáveis

1. Nenhuma regra de permissão vai para o prompt. Toda decisão sobre executar passa por `src/autonomy/gate.ts`.
2. Ação nova no catálogo exige: schema estrito de parâmetros com limites, classificação de reversibilidade, teto de autonomia e teste provando o bloqueio fora do limite.
3. Toda saída do LLM passa por schema Zod via `generateStructured` (um retry, depois erro explícito).
4. Nenhum teste chama LLM real nem serviço externo da internet. Use `FakeLlmClient` e `Fixture*Source`. Os testes de integração só falam com o docker-compose local.
5. O executor é dry-run por padrão; o modo live (ADR 0014) exige configuração explícita e a allowlist de alvos. Nunca use kubeconfig, cluster ou contexto da máquina em testes.
6. Domínio 100% fictício; e-mails só `@example.com`; segredos só em variável de ambiente (valores `dev-only-*` no compose e no `.env.example`).
7. Docs em português do Brasil; identificadores de código em inglês.
8. Commits em Conventional Commits, com `git commit -F <arquivo>`.

## Comandos

```bash
pnpm install
make test                 # lint + typecheck + testes + evals com modelo falso (igual ao CI)
pnpm test                 # só os testes unitários (Vitest)
pnpm validate:playbooks   # valida playbooks e política
pnpm eval [--model real]  # evals
pnpm build                # dist/
make up | down | logs | ps | seed | audit | clean
make test-integration     # precisa de make up
make dev                  # copiloto no host com .env
```

## Estrutura

```
src/
  domain/      payload do Alertmanager
  playbooks/   schema, registro e renderização segura de consultas
  autonomy/    níveis, catálogo, política, orçamento, gate, auditoria
  llm/         porta, adaptador compatível com OpenAI, fake, saída estruturada
  signals/     Prometheus, Jaeger, resumo para o prompt, fontes fixas
  graph/       estado, etapas do LangGraph (triage, collect, diagnose, decide, act) e checkpointer Redis
  incident/    investigador, prompt, schema do diagnóstico, aprovações
  executor/    porta, dry-run, executor real, allowlist de alvos e adaptadores (Kubernetes, flags, DLQ)
  rag/         recuperação lexical de runbooks Markdown (só informa o diagnóstico, sem autoridade)
  storage/     porta de objetos e adaptador S3 (MinIO/AWS)
  telemetry/   OpenTelemetry, métricas, logs, decorador do LLM
  http/        webhook, aprovações, /metrics, /healthz
  app.ts       raiz de composição; main.ts sobe o serviço
playbooks/     um YAML por alerta
runbooks/      Markdown de referência por playbook (ADR 0017)
config/        autonomy-policy.yaml, executor-targets.yaml
evals/         dataset, respostas do modelo falso, harness e CLI
deploy/        Prometheus (métricas sintéticas e alertas), Alertmanager, MinIO, gerador de traces
tests/         unitários por módulo; tests/integration contra o compose
docs/          design doc, ADRs e roteiros do núcleo
```

## Fluxo de trabalho

1. Mudança relevante de decisão → ADR novo em `docs/adr/` (Contexto / Decisão / Consequências / Alternativas).
2. Playbook alterado → incremente `metadata.version`, ajuste o dataset de evals se necessário e rode `pnpm eval`.
3. Mudança no gate ou no catálogo → teste em `tests/autonomy/gate.test.ts` para o caminho permitido **e** o bloqueado.
4. Antes de commitar: `make test`. O CI roda os mesmos comandos, mais a validação do compose e o build da imagem.
5. Atualize README e design doc (seção "Próximos passos") quando algo sair do escopo.
