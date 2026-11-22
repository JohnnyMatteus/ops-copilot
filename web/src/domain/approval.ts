// Ação que mexe com dinheiro: aprovar exige digitar o nome do serviço (direção de identidade, tela 3).
const MONEY_SERVICES = new Set(['payments-events-go']);

export const requiresServiceConfirmation = (service: string, action: string): boolean =>
  MONEY_SERVICES.has(service) || action === 'replay_dlq_batch';

export const reasonLimits = { min: 3, max: 500 } as const;
