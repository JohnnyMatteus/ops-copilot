// Detector preditivo (ADR 0020). A cada ciclo roda a consulta `predict_linear` de cada regra; se o
// valor previsto passa do limite e o atual ainda não, abre uma investigação com um alerta sintético
// do playbook correspondente. Uma série não reabre dentro do cooldown nem enquanto a previsão persiste.
import { createHash } from 'node:crypto';
import type { ReplayGuard } from '../chatops/signature.js';
import type { Alert } from '../domain/alert.js';
import { durationToMs } from '../shared/duration.js';
import type { MetricSeries, MetricsSource } from '../signals/types.js';
import type { PredictiveRule } from './rules.js';

export type PredictionResult = 'opened' | 'already_breaching' | 'active' | 'cooldown' | 'error' | 'skipped';

export interface DetectorDeps {
  readonly rules: readonly PredictiveRule[];
  readonly source: MetricsSource;
  readonly investigate: (alert: Alert) => Promise<unknown>;
  readonly now: () => Date;
  /** Reserva atômica por regra+série pelo cooldown, compartilhada entre réplicas (Redis `SET NX`). */
  readonly cooldown: ReplayGuard;
  readonly onResult?: (rule: PredictiveRule, result: PredictionResult) => void;
  readonly onError?: (rule: PredictiveRule, error: unknown) => void;
}

const lastValue = (series: MetricSeries): number => series.points.at(-1)?.v ?? Number.NaN;
const labelsKey = (labels: Readonly<Record<string, string>>): string =>
  JSON.stringify(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1)));

export class PredictiveDetector {
  readonly #deps: DetectorDeps;
  /** Séries com previsão de violação já tratada, até a previsão se desfazer. */
  readonly #active = new Set<string>();
  #running = false;

  constructor(deps: DetectorDeps) {
    this.#deps = deps;
  }

  /** Não reentra: um ciclo lento (espera as investigações) não ganha um segundo ciclo por cima. */
  async tick(): Promise<Alert[]> {
    if (this.#running) {
      for (const rule of this.#deps.rules) this.#deps.onResult?.(rule, 'skipped');
      return [];
    }
    this.#running = true;
    try {
      const opened: Alert[] = [];
      for (const rule of this.#deps.rules) {
        try {
          opened.push(...(await this.#evaluate(rule)));
        } catch (error) {
          this.#deps.onResult?.(rule, 'error');
          this.#deps.onError?.(rule, error);
        }
      }
      return opened;
    } finally {
      this.#running = false;
    }
  }

  async #evaluate(rule: PredictiveRule): Promise<Alert[]> {
    const now = this.#deps.now();
    const at = (query: string, name: string) =>
      this.#deps.source.query({ name, description: rule.summary, query, kind: 'instant', window: '30m', step: '60s' }, now);
    const predicted = (await at(rule.predict, rule.name)).filter((series) => lastValue(series) > rule.threshold);
    const breaching = new Set(predicted.map((series) => `${rule.name}|${labelsKey(series.labels)}`));
    for (const key of this.#active) if (key.startsWith(`${rule.name}|`) && !breaching.has(key)) this.#active.delete(key);
    if (predicted.length === 0) return [];

    const current = new Map((await at(rule.current, `${rule.name}-atual`)).map((series) => [labelsKey(series.labels), lastValue(series)]));
    const opened: Alert[] = [];
    for (const series of predicted) {
      const key = `${rule.name}|${labelsKey(series.labels)}`;
      if (this.#active.has(key)) {
        this.#deps.onResult?.(rule, 'active');
        continue;
      }
      const currentValue = current.get(labelsKey(series.labels));
      // Sem valor atual não há como saber se o alerta real já cobre o caso: não abre, é erro.
      if (currentValue === undefined || Number.isNaN(currentValue)) {
        this.#deps.onResult?.(rule, 'error');
        this.#deps.onError?.(rule, new Error(`Sem valor atual para ${key}; a previsão não foi usada.`));
        continue;
      }
      if (currentValue >= rule.threshold) {
        this.#deps.onResult?.(rule, 'already_breaching');
        continue;
      }
      // Quem reserva a série pelo cooldown abre; as demais réplicas (e este processo, depois) não.
      // Falha da reserva propaga como erro do ciclo: na dúvida, não abre.
      if (!(await this.#deps.cooldown.firstSeen(key, durationToMs(rule.cooldown)))) {
        this.#active.add(key);
        this.#deps.onResult?.(rule, 'cooldown');
        continue;
      }
      this.#active.add(key);
      const alert = this.#alertFor(rule, series, now);
      opened.push(alert);
      this.#deps.onResult?.(rule, 'opened');
      await this.#deps.investigate(alert).catch((error: unknown) => this.#deps.onError?.(rule, error));
    }
    return opened;
  }

  #alertFor(rule: PredictiveRule, series: MetricSeries, now: Date): Alert {
    const predictedValue = lastValue(series);
    return {
      fingerprint: createHash('sha256').update(`predictive:${rule.name}:${labelsKey(series.labels)}`).digest('hex').slice(0, 16),
      alertname: rule.alertname,
      service: rule.service,
      severity: 'warning',
      startsAt: now.toISOString(),
      labels: { ...series.labels, alertname: rule.alertname, service: rule.service, origin: 'predictive' },
      annotations: {
        summary: `Previsão: ${rule.summary} Valor previsto em ${rule.horizon}: ${predictedValue.toFixed(2)} (limite ${String(rule.threshold)}).`,
        predicted: 'true',
        predicted_value: predictedValue.toFixed(2),
        horizon: rule.horizon,
      },
    };
  }
}
