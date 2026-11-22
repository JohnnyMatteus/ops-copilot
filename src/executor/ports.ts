// Portas dos efeitos reais. O executor só conhece estas interfaces; clientes oficiais e HTTP ficam
// nos adaptadores.

export interface KubernetesPort {
  replicas(namespace: string, deployment: string): Promise<number>;
  /** Falha se o valor atual não for `from`: outra pessoa mexeu no deployment no meio do caminho. */
  setReplicas(namespace: string, deployment: string, from: number, to: number): Promise<void>;
  restart(namespace: string, deployment: string, at: Date): Promise<void>;
}

export interface FeatureFlagPort {
  isEnabled(flag: string): Promise<boolean>;
  set(flag: string, enabled: boolean): Promise<void>;
}

export interface DlqPort {
  /** Move até `max` mensagens de `queue` para `replayTo` e devolve quantas moveu. */
  replay(queue: string, replayTo: string, max: number): Promise<number>;
}

export interface NotifierPort {
  notify(channel: string, text: string): Promise<void>;
}
