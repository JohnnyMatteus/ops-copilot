## O que muda

<!-- Uma ou duas frases sobre o problema e a solução. -->

## Tipo

- [ ] Playbook novo ou alterado
- [ ] Política de autonomia (`config/autonomy-policy.yaml`)
- [ ] Gate, catálogo de ações ou executor
- [ ] Grafo, prompt ou cliente LLM
- [ ] Infraestrutura local, CI ou documentação

## Checklist

- [ ] `make test` passa (lint, typecheck, testes e evals com modelo falso)
- [ ] Mudança em autonomia ou catálogo tem teste provando o bloqueio do que deve continuar bloqueado
- [ ] Playbook alterado teve a `metadata.version` incrementada
- [ ] Mudança de prompt ou playbook rodou `pnpm eval --model real` (cole o acerto abaixo)
- [ ] ADR criado ou atualizado se a decisão for relevante
- [ ] Nenhum segredo, nome real ou dado de produção

## Evals

<!-- Acerto de hipótese, ação e desfecho antes/depois, quando aplicável. -->
