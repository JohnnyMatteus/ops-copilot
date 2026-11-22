# Alvos padronizados do ambiente local. `make help` lista todos.
COMPOSE := docker compose
PROFILES := --profile core --profile observability
SCENARIO ?= saas
# O painel mostra o commit da política e dos playbooks carregados.
export GIT_COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo desconhecido)

.PHONY: help network up up-portfolio down logs ps seed audit dev web-dev web-test test test-integration lint eval build clean

help: ## Lista os alvos
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-17s %s\n", $$1, $$2}'

network: ## Cria a rede compartilhada portfolio-net (idempotente)
	@docker network inspect portfolio-net >/dev/null 2>&1 || docker network create portfolio-net

up: ## Sobe copiloto, LocalStack S3 e a stack de observabilidade sintética (modo autônomo)
	$(COMPOSE) $(PROFILES) up -d --build --wait

up-portfolio: network ## Sobe só o núcleo na portfolio-net, observando os outros projetos
	$(COMPOSE) -f docker-compose.yml -f docker-compose.portfolio.yml --profile core up -d --build --wait

down: ## Para os contêineres (mantém volumes)
	$(COMPOSE) $(PROFILES) down

logs: ## Acompanha os logs
	$(COMPOSE) $(PROFILES) logs -f --tail=100

ps: ## Estado dos serviços
	$(COMPOSE) $(PROFILES) ps

seed: ## Dispara um alerta de exemplo (SCENARIO=saas|payments|telemetry)
	./scripts/seed-alert.sh $(SCENARIO)

audit: ## Lista os objetos (e versões) da trilha de auditoria no S3 local (LocalStack)
	$(COMPOSE) --profile core exec -T localstack awslocal s3api list-object-versions --bucket "$(or $(AUDIT_S3_BUCKET),ops-copilot-audit)"

dev: ## Roda o copiloto no host com recarga (usa .env)
	pnpm dev

web-dev: ## Roda o painel Vigília com Vite (proxy /api para o copiloto em localhost:8080)
	cd web && pnpm install && pnpm dev

web-test: ## Lint, typecheck, testes e build do painel
	cd web && pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build

test: ## Lint, typecheck, testes unitários e evals com modelo falso
	pnpm lint && pnpm typecheck && pnpm test && pnpm eval

test-integration: ## Testes contra Prometheus, Jaeger, LocalStack S3 e Redis do compose (rode make up antes)
	pnpm test:integration

lint: ## Lint e typecheck
	pnpm lint && pnpm typecheck

eval: ## Evals com modelo falso (MODEL=real usa o LLM do .env)
	pnpm eval --model $(or $(MODEL),fake)

build: ## Compila TypeScript para dist/
	pnpm build

clean: ## Remove contêineres, volumes e artefatos locais
	$(COMPOSE) $(PROFILES) down -v --remove-orphans
	rm -rf dist coverage var evals/reports
