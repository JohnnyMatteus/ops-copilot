---
title: Runbook da latência p99 do SaaS multi-tenant
playbooks: [saas-p99-latency]
---

# Latência p99 do SaaS

## Vizinho barulhento

Quando um único tenant concentra a maior parte das requisições e a exportação pesada de relatórios está ligada, desligar a flag da exportação protege os demais tenants. Religue quando o volume normalizar.

## Saturação geral

CPU alta em todas as réplicas sem um tenant dominante pede mais réplicas, respeitando o teto do deployment.
