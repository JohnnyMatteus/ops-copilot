// Todo dado do servidor passa pelo TanStack Query. Incidentes e aprovações são reconsultados a
// cada poucos segundos: o plantão precisa ver o prazo e as novas investigações sem recarregar.
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, type MaybeRef, toValue } from 'vue';
import { z } from 'zod';
import { get, post } from './client';
import {
  ApprovalSchema,
  AuditRecordSchema,
  BudgetSchema,
  ConfigSchema,
  IncidentSchema,
  OperatorSchema,
  OutcomeResponseSchema,
  PlaybooksSchema,
  PolicySchema,
  VerificationSchema,
} from './schemas';
import { token } from '@/auth/session';

const POLL_MS = 5_000;
const signedIn = computed(() => token.value !== null);

export const useConfig = () => useQuery({ queryKey: ['config'], queryFn: () => get(ConfigSchema, '/config'), staleTime: Infinity });

export const useMe = () =>
  useQuery({ queryKey: ['me', token], queryFn: () => get(OperatorSchema, '/me'), enabled: signedIn, retry: false, staleTime: Infinity });

export const useIncidents = () =>
  useQuery({
    queryKey: ['incidents'],
    queryFn: () => get(z.array(IncidentSchema), '/incidents'),
    enabled: signedIn,
    refetchInterval: POLL_MS,
  });

export const useIncident = (id: MaybeRef<string>) =>
  useQuery({
    queryKey: ['incident', id],
    queryFn: () => get(IncidentSchema, `/incidents/${toValue(id)}`),
    enabled: signedIn,
    refetchInterval: POLL_MS,
  });

export const useApprovals = () =>
  useQuery({
    queryKey: ['approvals'],
    queryFn: () => get(z.array(ApprovalSchema), '/approvals'),
    enabled: signedIn,
    refetchInterval: POLL_MS,
  });

export const useAudit = (incidentId: MaybeRef<string | null>) =>
  useQuery({
    queryKey: ['audit', incidentId],
    queryFn: () => {
      const incident = toValue(incidentId);
      return get(z.array(AuditRecordSchema), '/audit', incident ? { incidentId: incident, limit: '500' } : { limit: '500' });
    },
    enabled: signedIn,
    refetchInterval: POLL_MS * 2,
  });

export const usePolicy = () => useQuery({ queryKey: ['policy'], queryFn: () => get(PolicySchema, '/policy'), enabled: signedIn });
export const usePlaybooks = () => useQuery({ queryKey: ['playbooks'], queryFn: () => get(PlaybooksSchema, '/playbooks'), enabled: signedIn });
export const useBudget = () =>
  useQuery({ queryKey: ['budget'], queryFn: () => get(BudgetSchema, '/budget'), enabled: signedIn, refetchInterval: POLL_MS * 2 });

export const useVerifyChain = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => get(VerificationSchema, '/audit/verify'),
    onSuccess: (result) => client.setQueryData(['verification'], result),
  });
};

function useDecisionMutation<T>(run: (input: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: async () => {
      await Promise.all(
        ['incidents', 'incident', 'approvals', 'audit', 'budget'].map((key) => client.invalidateQueries({ queryKey: [key] })),
      );
    },
  });
}

export interface DecisionInput {
  readonly approvalId: string;
  readonly decision: 'approve' | 'reject';
  readonly reason?: string;
}

/** A identidade de quem decide viaja na credencial; o corpo só leva a decisão e o motivo. */
export const useDecide = () =>
  useDecisionMutation(({ approvalId, decision, reason }: DecisionInput) =>
    post(OutcomeResponseSchema, `/approvals/${approvalId}`, reason ? { decision, reason } : { decision }),
  );

export const useCancel = () =>
  useDecisionMutation(({ incidentId, reason }: { incidentId: string; reason: string }) =>
    post(OutcomeResponseSchema, `/incidents/${incidentId}/cancel`, { reason }),
  );

/** Reverte a ação executada pela inversa guardada; passa pelo gate e é auditado no servidor. */
export const useRollback = () =>
  useDecisionMutation(({ incidentId, reason }: { incidentId: string; reason: string }) =>
    post(OutcomeResponseSchema, `/incidents/${incidentId}/rollback`, { reason }),
  );
