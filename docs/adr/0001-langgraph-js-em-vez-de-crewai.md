# ADR 0001: Grafo LangGraph.js com etapas fixas, em vez de CrewAI

- **Status:** Aceito
- **Data:** 2026-11-21

## Contexto

O copiloto investiga incidentes de três serviços do portfólio (payments-events-go, saas-multitenant e kafka-telemetry). Cada investigação segue sempre os mesmos passos: casar o alerta com um playbook, coletar sinais, diagnosticar, decidir e agir. O que muda é o conteúdo de cada passo, não a ordem.

Frameworks multiagente como o CrewAI (Python) organizam o trabalho em "equipes" de agentes com papéis e delegação livre entre eles. O agente de posicionamento do mesmo autor já usa LangGraph.js em TypeScript, com nós fixos e estado validado por Zod.

## Decisão

Usar **LangGraph.js** (TypeScript, Node 22) com um `StateGraph` de cinco etapas fixas: `triage → collect → diagnose → decide → act`. As arestas condicionais olham só o campo `outcome`: qualquer etapa pode encerrar o fluxo, nenhuma pode pular a seguinte. O LLM é chamado em um único nó (`diagnose`).

## Consequências

- O fluxo é previsível e auditável: dá para dizer, para qualquer incidente, por quais etapas ele passou e por que parou.
- Custo e latência ficam limitados: uma chamada ao LLM por incidente, mais um retry no máximo.
- A stack fica igual à do agente de posicionamento (LangGraph.js, Zod, Vitest e o mesmo padrão de cliente LLM), o que reduz o custo de manter os dois projetos.
- A flexibilidade é menor. Investigações abertas, em que o modelo escolhe livremente quais consultas fazer (estilo ReAct), ficam fora do escopo da fundação. Se vierem, entram como um subgrafo limitado dentro de `collect`, sem mudar o restante do fluxo.

## Alternativas consideradas

- **CrewAI:** bom para delegação entre papéis, mas exigiria Python e um segundo runtime no portfólio de IA. A orquestração livre também dificulta provar que uma ação passou pelo gate.
- **Agente ReAct livre com ferramentas:** o modelo decide a ordem das consultas. É mais flexível, mas o custo é imprevisível e o comportamento mais difícil de testar e de auditar.
- **Código procedural sem framework:** funcionaria para cinco etapas. O LangGraph.js dá estado tipado, arestas condicionais declarativas e um caminho natural para checkpoints e humano no loop, sem custo relevante.
