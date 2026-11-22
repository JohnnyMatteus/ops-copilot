---
title: Runbook do lag do consumidor de telemetria
playbooks: [telemetry-consumer-lag]
---

# Lag do consumidor de leituras

## Lag distribuído

Lag crescendo em todas as partições, sem erros, indica falta de réplicas do consumidor. Aumentar réplicas ajuda enquanto o destino das escritas está saudável.

## Escrita lenta na base de séries temporais

Se os traces mostram a escrita lenta, mais réplicas aumentam a pressão sobre a base. Primeiro avise o plantão da base; escalar o consumidor só depois.

## Partição isolada

Uma única partição com lag e as demais em dia aponta para um registro que trava o processamento. Reiniciar pods não ajuda; o plantão precisa inspecionar o registro.
