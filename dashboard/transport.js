// Dos fuentes de datos con la misma interfaz:
//  - live: el servidor real (Server-Sent Events + API REST).
//  - demo: todo simulado en el navegador, para GitHub Pages o sin servidor.
//    Usa los MISMOS módulos que el servidor y el simulador (cola, ECG,
//    escenario y motor de alertas), así que lo que ves es la lógica real.
import { StoreAndForwardQueue } from './shared/queue.js';
import { EcgSynth } from './shared/ecg.js';
import { makeScenario, DEFAULT_CYCLE_S, DEFAULT_OUTAGE } from './shared/scenario.js';
import { AlertEngine } from './shared/alerts.js';
import { toFhirBundle } from './shared/fhir.js';

export async function pickTransport() {
  const params = new URLSearchParams(location.search);
  if (params.has('demo') || location.hostname.endsWith('github.io')) return demoTransport();
  try {
    const r = await fetch('healthz', { cache: 'no-store' });
    if (r.ok) return liveTransport();
  } catch { /* sin servidor */ }
  return demoTransport();
}

// ═════════════════════════════════════════════════════════════════════════════
function liveTransport() {
  return {
    kind: 'live',
    subscribe(handlers, onError) {
      const es = new EventSource('api/v1/stream');
      for (const [name, fn] of Object.entries(handlers)) {
        es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
      }
      es.onerror = onError;
    },
    vitals: (id, minutes) =>
      fetch(`api/v1/devices/${encodeURIComponent(id)}/vitals?minutes=${minutes}`).then((r) => r.json()),
    ack: (id) => fetch(`api/v1/alerts/${id}/ack`, { method: 'POST' }),
    openFhir(id) {
      window.open(`fhir/Observation?device=${encodeURIComponent(id)}&minutes=60`, '_blank', 'noopener');
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
function demoTransport() {
  const FS = 125;
  const DEVICE = { id: 'maletin-demo-01', patient_id: 'P-DEMO', firmware: 'demo-navegador', last_boot_id: 'demo' };
  const queue = new StoreAndForwardQueue({ capacity: 5000, bootId: 'demo' });
  const synth = new EcgSynth({ fs: FS });
  const scenario = makeScenario(7);
  const engine = new AlertEngine();
  const history = [];   // vitales ya "recibidos"
  const alerts = [];
  const stats = { records: 0, backfilled: 0, alerts: 0, retroactive_alerts: 0 };
  let handlers = {};
  let tick = 0;
  let manual = null;    // null = corte automático programado; true/false = forzado por el usuario
  let lastSeen = Date.now();
  let liveEcg = [], rollingEcg = [];
  let alertId = 1;

  const emit = (name, data) => handlers[name]?.(data);
  const scheduledOffline = (s) => s >= DEFAULT_OUTAGE.at && s < DEFAULT_OUTAGE.at + DEFAULT_OUTAGE.for;
  const isOffline = () => (manual ?? scheduledOffline(tick % DEFAULT_CYCLE_S));
  const device = () => ({ ...DEVICE, last_seen: lastSeen, queue_depth: queue.depth, dropped: queue.dropped, online: !isOffline() });

  function step() {
    const s = tick % DEFAULT_CYCLE_S;
    const now = Date.now();
    const offline = isOffline();
    const v = scenario(s);
    queue.push({ kind: 'vitals', ts: now, ...v });

    const samples = synth.next(FS, v.hr);
    rollingEcg = rollingEcg.concat(samples).slice(-FS * 10);
    if (!offline) {
      liveEcg = liveEcg.concat(samples);
      if (liveEcg.length >= FS * 2) {
        queue.push({ kind: 'ecg', ts: now, fs: FS, samples: liveEcg, lead_off: v.lead_off });
        liveEcg = [];
      }
      // "Enviar" la cola: el ESP32 manda varios lotes por segundo al reconectar.
      const batch = queue.peekBatch(300);
      if (batch.length) {
        lastSeen = now;
        deliver(batch, now);
        queue.ack(batch);
      }
    } else {
      liveEcg = [];
      if (s % 30 === 0) queue.push({ kind: 'ecg', ts: now, fs: FS, samples: rollingEcg, lead_off: v.lead_off });
    }
    emit('device', device());
    emit('stats', { ...stats });
    tick += 1;
  }

  function deliver(batch, receivedAt) {
    for (const r of batch) {
      stats.records += 1;
      if (receivedAt - r.ts > 5_000) stats.backfilled += 1;
      if (r.kind === 'vitals') {
        const row = { device_id: DEVICE.id, ts: r.ts, ts_quality: 'derived', received_at: receivedAt, hr: r.hr, spo2: r.spo2, temp: r.temp, lead_off: r.lead_off };
        history.push(row);
        if (history.length > 1200) history.shift();
        emit('vitals', row);
        for (const a of engine.evaluate({ deviceId: DEVICE.id, patientId: DEVICE.patient_id, receivedAt, ...row })) {
          const alert = { id: alertId++, ...a, acked_at: null };
          alerts.unshift(alert);
          stats.alerts += 1;
          if (alert.retroactive) stats.retroactive_alerts += 1;
          emit('alert', alert);
        }
      } else if (receivedAt - r.ts < 10_000) {
        emit('ecg', { device_id: DEVICE.id, ts: r.ts, fs: r.fs, samples: r.samples, lead_off: r.lead_off });
      }
    }
  }

  return {
    kind: 'demo',
    subscribe(h) {
      handlers = h;
      emit('snapshot', { devices: [device()], alerts: [], stats: { ...stats } });
      step();
      setInterval(step, 1000);
    },
    vitals: async (id, minutes) => history.filter((r) => r.ts >= Date.now() - minutes * 60_000),
    ack: async (id) => {
      const a = alerts.find((x) => x.id === id);
      if (a && !a.acked_at) { a.acked_at = Date.now(); emit('ack', { id, acked_at: a.acked_at }); }
    },
    openFhir() {
      const bundle = toFhirBundle({ device: device(), rows: history, baseUrl: location.origin });
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
      window.open(url, '_blank', 'noopener');
    },
    // Controles propios del modo demo
    network: {
      get offline() { return isOffline(); },
      get manual() { return manual !== null; },
      toggle() { manual = !isOffline(); emit('device', device()); },
      auto() { manual = null; emit('device', device()); },
      secondsToScheduledChange() {
        const s = tick % DEFAULT_CYCLE_S;
        const { at, for: dur } = DEFAULT_OUTAGE;
        if (s < at) return at - s;
        if (s < at + dur) return at + dur - s;
        return DEFAULT_CYCLE_S - s + at;
      },
    },
  };
}
