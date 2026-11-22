---
title: Runbook da DLQ de eventos de pagamento
playbooks: [payments-dlq-backlog]
---

# DLQ de eventos de pagamento

## Quando reprocessar

Antes de reprocessar, confirme que a dependência que causou a falha voltou. O ledger-api precisa estar disponível por pelo menos dez minutos seguidos. Reprocessar com a dependência fora devolve as mensagens para a DLQ e repete cobranças parciais.

## Mensagem envenenada

Se o mesmo tipo de evento falha sempre, com as dependências saudáveis, o problema é o formato da mensagem. Reprocessar não resolve: separe o evento, abra um chamado para o time de pagamentos e deixe o restante da fila andar.

## Saturação do consumidor

Consumidor sem erros e com vazão baixa faz as mensagens expirarem por timeout e caírem na DLQ. Olhe a utilização de CPU do consumidor e o atraso de processamento antes de qualquer outra coisa.
