import { describe, expect, it } from 'vitest';
import { ACTION_CATALOG, INVERSE_ACTION_IDS } from '../../src/autonomy/catalog.js';

describe('ações inversas no catálogo', () => {
  it('toda inversa declarada existe, nunca roda sem aprovação e rejeita parâmetros fora do limite', () => {
    for (const definition of Object.values(ACTION_CATALOG)) {
      if (!('inverse' in definition)) continue;
      const inverse = ACTION_CATALOG[definition.inverse as keyof typeof ACTION_CATALOG];
      expect(inverse.maxAutonomy).toBe('execute_with_approval');
    }
    expect([...INVERSE_ACTION_IDS].sort()).toEqual(['restore_deployment_replicas', 'restore_feature_flag']);
    expect(ACTION_CATALOG.restore_deployment_replicas.params.safeParse({ deployment: 'a', replicas: 13 }).success).toBe(false);
    expect(ACTION_CATALOG.restore_deployment_replicas.params.safeParse({ deployment: 'a', replicas: 4, extra: 1 }).success).toBe(false);
    expect(ACTION_CATALOG.restore_feature_flag.params.safeParse({ flag: 'f', enabled: false }).success).toBe(false);
  });
});
