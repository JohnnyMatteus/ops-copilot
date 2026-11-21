// Grafo de investigação com etapas fixas (ADR 0001). Cada etapa pode encerrar o fluxo
// preenchendo `outcome`; as arestas condicionais só olham esse campo.
import { END, START, StateGraph } from '@langchain/langgraph';
import { withSpan } from '../telemetry/tracing.js';
import type { InvestigationDeps } from './deps.js';
import { createActNode } from './nodes/act.js';
import { createCollectNode } from './nodes/collect.js';
import { createDecideNode } from './nodes/decide.js';
import { createDiagnoseNode } from './nodes/diagnose.js';
import { createTriageNode } from './nodes/triage.js';
import { InvestigationState, type InvestigationStateType, type InvestigationUpdate } from './state.js';

export const NODE_ORDER = ['triage', 'collect', 'diagnose', 'decide', 'act'] as const;
type NodeName = (typeof NODE_ORDER)[number];

type Node = (state: InvestigationStateType) => Promise<InvestigationUpdate>;

/** Envolve a etapa num span e registra a duração no histograma. */
function instrument(deps: InvestigationDeps, name: NodeName, node: Node): Node {
  return (state) => {
    const stopTimer = deps.metrics.nodeDuration.startTimer({ node: name });
    return withSpan(deps.tracer, `ops_copilot.node.${name}`, { 'ops_copilot.incident_id': state.incidentId }, async (set) => {
      try {
        const update = await node(state);
        if (update.outcome) set({ 'ops_copilot.outcome': update.outcome });
        return { ...update, steps: [name] };
      } finally {
        stopTimer();
      }
    });
  };
}

const continueUnlessFinished = (next: NodeName) => (state: InvestigationStateType) =>
  state.outcome ? END : next;

export function buildInvestigationGraph(deps: InvestigationDeps) {
  return new StateGraph(InvestigationState)
    .addNode('triage', instrument(deps, 'triage', createTriageNode(deps)))
    .addNode('collect', instrument(deps, 'collect', createCollectNode(deps)))
    .addNode('diagnose', instrument(deps, 'diagnose', createDiagnoseNode(deps)))
    .addNode('decide', instrument(deps, 'decide', createDecideNode(deps)))
    .addNode('act', instrument(deps, 'act', createActNode(deps)))
    .addEdge(START, 'triage')
    .addConditionalEdges('triage', continueUnlessFinished('collect'), ['collect', END])
    .addConditionalEdges('collect', continueUnlessFinished('diagnose'), ['diagnose', END])
    .addConditionalEdges('diagnose', continueUnlessFinished('decide'), ['decide', END])
    .addConditionalEdges('decide', continueUnlessFinished('act'), ['act', END])
    .addEdge('act', END)
    .compile();
}

export type InvestigationGraph = ReturnType<typeof buildInvestigationGraph>;
