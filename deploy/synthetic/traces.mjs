// Gerador de traces sintéticos dos três serviços, sem dependências: envia OTLP/HTTP em JSON.
// As durações seguem os mesmos ciclos das métricas sintéticas do Prometheus, então traces e
// métricas contam a mesma história quando um alerta dispara.
/* global fetch, setInterval, console, process, crypto, Buffer */
import { writeFile } from 'node:fs/promises';

const ENDPOINT = process.env.OTLP_ENDPOINT ?? 'http://localhost:4318';
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 2000);

const hex = (bytes) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex');
const phase = (periodSeconds, offset = 0) => Math.sin(Date.now() / 1000 / periodSeconds + offset);

/** Monta um trace: a raiz dura o suficiente para conter os filhos em sequência. */
function buildTrace(rootName, children) {
  const traceId = hex(16);
  const rootId = hex(8);
  const start = BigInt(Date.now()) * 1_000_000n;
  let cursor = start;
  const spans = children.map((child) => {
    const begin = cursor;
    cursor += BigInt(Math.round(child.ms * 1_000_000));
    return {
      traceId,
      spanId: hex(8),
      parentSpanId: rootId,
      name: child.name,
      kind: 3,
      startTimeUnixNano: begin.toString(),
      endTimeUnixNano: cursor.toString(),
      status: { code: child.error ? 2 : 1 },
    };
  });
  const failed = children.some((child) => child.error);
  spans.unshift({
    traceId,
    spanId: rootId,
    name: rootName,
    kind: 2,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: (cursor + 2_000_000n).toString(),
    status: { code: failed ? 2 : 1 },
  });
  return spans;
}

const services = {
  'saas-multitenant': () => {
    const pressure = Math.max(0, phase(450));
    return Math.random() < 0.5
      ? buildTrace('GET /api/v1/reports/export', [
          { name: 'tenant.resolve', ms: 2 },
          { name: 'mysql.query reports_by_month', ms: 40 + 300 * pressure },
          { name: 'reports.render_csv', ms: 200 + 2200 * pressure },
        ])
      : buildTrace('GET /api/v1/bookings', [
          { name: 'tenant.resolve', ms: 2 },
          { name: 'mysql.query bookings_by_week', ms: 30 + 200 * pressure },
          { name: 'bookings.serialize', ms: 15 },
        ]);
  },
  'payments-events-go': () => {
    const ledgerDown = phase(600, 0.6) >= 0.3;
    return buildTrace('process_payment_event', [
      { name: 'event.decode', ms: 1 },
      { name: 'idempotency.check', ms: 3 },
      { name: 'ledger.post_entry', ms: ledgerDown ? 5000 : 40 + Math.random() * 30, error: ledgerDown },
    ]);
  },
  'kafka-telemetry': () => {
    const pressure = Math.max(0, phase(900));
    return buildTrace('enrich_reading', [
      { name: 'schema.decode', ms: 2 },
      { name: 'greenhouse.lookup', ms: 5 },
      { name: 'tsdb.write', ms: 20 + 150 * pressure },
    ]);
  },
};

async function emit() {
  const resourceSpans = Object.entries(services).map(([service, generate]) => ({
    resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
    scopeSpans: [{ scope: { name: 'ops-copilot-synthetic' }, spans: generate() }],
  }));
  try {
    const response = await fetch(`${ENDPOINT}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceSpans }),
    });
    if (!response.ok) console.error(`OTLP respondeu HTTP ${response.status}`);
    // Batimento lido pelo healthcheck do compose.
    else await writeFile('/tmp/heartbeat', String(Date.now()));
  } catch (error) {
    console.error(`Falha ao enviar traces: ${error.message}`);
  }
}

console.error(`Gerando traces sintéticos para ${ENDPOINT} a cada ${INTERVAL_MS}ms`);
setInterval(emit, INTERVAL_MS);
