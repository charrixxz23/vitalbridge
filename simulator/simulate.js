#!/usr/bin/env node
// Simulador de maletín: genera ECG + signos vitales, los encola y los envía
// con la misma lógica store-and-forward del firmware, incluyendo cortes de red.
//
//   npm run sim                              # escenario por defecto
//   npm run sim -- --outage-at 10 --outage-for 60
//   npm run sim -- --no-outage --lose-acks 0.2
//
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { StoreAndForwardQueue } from '../shared/queue.js';
import { EcgSynth, mulberry32 } from '../shared/ecg.js';
import { makeScenario } from '../shared/scenario.js';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8080' },
    token: { type: 'string', default: 'demo-token' },
    device: { type: 'string', default: 'maletin-sim-01' },
    patient: { type: 'string', default: 'P-0001' },
    cycle: { type: 'string', default: '150' },        // duración del escenario (s)
    'outage-at': { type: 'string', default: '20' },   // inicio del corte dentro del ciclo (s)
    'outage-for': { type: 'string', default: '60' },  // duración del corte (s)
    'no-outage': { type: 'boolean', default: false },
    'lose-acks': { type: 'string', default: '0' },    // prob. de perder la respuesta HTTP
    ntp: { type: 'boolean', default: false },         // enviar hora absoluta (como si hubiera NTP)
    duration: { type: 'string', default: '0' },       // 0 = infinito
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(`Uso: npm run sim -- [opciones]
  --url URL            servidor (por defecto http://localhost:8080)
  --token TOKEN        token de ingesta (demo-token)
  --device ID          id del equipo (maletin-sim-01)
  --patient ID         id del paciente (P-0001)
  --cycle S            duración del escenario clínico en segundos (150)
  --outage-at S        segundo del ciclo en que se cae la red (20)
  --outage-for S       duración del corte (60)
  --no-outage          sin cortes
  --lose-acks P        probabilidad 0–1 de perder la respuesta (prueba idempotencia)
  --ntp                el equipo conoce la hora absoluta
  --duration S         terminar tras S segundos (0 = nunca)`);
  process.exit(0);
}

const CYCLE = Number(args.cycle);
const OUTAGE_AT = Number(args['outage-at']);
const OUTAGE_FOR = args['no-outage'] ? 0 : Number(args['outage-for']);
const LOSE_ACKS = Number(args['lose-acks']);
const DURATION = Number(args.duration);
const FS = 125;
const BATCH = 100;

const bootId = randomBytes(4).toString('hex');
const bootedAt = Date.now();
const uptime = () => Date.now() - bootedAt;
const rand = mulberry32(11); // azar para --lose-acks
const queue = new StoreAndForwardQueue({ capacity: 5000, bootId });
const ecg = new EcgSynth({ fs: FS });
const log = (...m) => { if (!args.quiet) console.log(new Date().toLocaleTimeString(), ...m); };

// Escenario clínico compartido con el modo demo del navegador (shared/scenario.js).
const scenario = makeScenario(7);

const isOffline = (s) => OUTAGE_FOR > 0 && s >= OUTAGE_AT && s < OUTAGE_AT + OUTAGE_FOR;

// ── Bucle principal: 1 tick por segundo ──────────────────────────────────────
let tick = 0;
let wasOffline = false;
let liveEcg = [];        // tira en vivo (2 s)
let rollingEcg = [];     // últimos 10 s (para guardar sin red)
let pendingRetry = null; // lote cuyo ACK se "perdió"

async function postBatch(batch) {
  const body = {
    device_id: args.device,
    patient_id: args.patient,
    boot_id: bootId,
    firmware: 'sim-0.1.0',
    uptime_ms: uptime(),
    queue_depth: queue.depth,
    dropped: queue.dropped,
    records: batch.map(({ boot, ...r }) => (boot === bootId ? r : { ...r, boot })),
  };
  const res = await fetch(`${args.url}/api/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${args.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function step() {
  const s = tick % CYCLE;
  const v = scenario(s);
  const t = uptime();
  const stamp = args.ntp ? { t, epoch: Date.now() } : { t };
  const offline = isOffline(s);

  queue.push({ kind: 'vitals', ...stamp, ...v });

  const samples = ecg.next(FS, v.hr);
  rollingEcg = rollingEcg.concat(samples).slice(-FS * 10);
  if (!offline) {
    liveEcg = liveEcg.concat(samples);
    if (liveEcg.length >= FS * 2) {
      queue.push({ kind: 'ecg', ...stamp, fs: FS, samples: liveEcg, lead_off: v.lead_off });
      liveEcg = [];
    }
  } else if (s % 30 === 0) {
    // Sin red no se guarda ECG continuo (no cabe): una tira de 10 s cada 30 s.
    queue.push({ kind: 'ecg', ...stamp, fs: FS, samples: rollingEcg, lead_off: v.lead_off });
  }

  if (offline !== wasOffline) {
    log(offline ? '📡✖  Sin señal: guardando en la cola local' : `📡✔  Señal recuperada: ${queue.depth} registros por enviar`);
    wasOffline = offline;
    liveEcg = [];
  }
  if (offline) {
    if (s % 10 === 0) log(`   cola=${queue.depth}  FC=${v.hr}  SpO₂=${v.spo2}%`);
    return;
  }

  // Vaciar la cola: varios lotes por tick para ponerse al día rápido.
  for (let i = 0; i < 10 && queue.depth > 0; i++) {
    const batch = pendingRetry ?? queue.peekBatch(BATCH);
    try {
      const r = await postBatch(batch);
      if (rand() < LOSE_ACKS) {
        pendingRetry = batch; // el servidor lo guardó, pero el equipo no se enteró
        log(`   ⚠  respuesta perdida (lote de ${batch.length}); se reenviará`);
        break;
      }
      pendingRetry = null;
      queue.ack(batch);
      if (r.duplicates || r.alerts || batch.length > 5) {
        log(`   ↑ ${batch.length} enviados → nuevos ${r.accepted}, duplicados ${r.duplicates}, alertas ${r.alerts}, cola ${queue.depth}`);
      }
    } catch (err) {
      log(`   ✖ envío falló (${err.cause?.code ?? err.message}); los datos siguen en la cola`);
      break;
    }
  }
}

log(`Simulador ${args.device} (arranque ${bootId}) → ${args.url}`);
log(OUTAGE_FOR ? `Corte de red programado: segundo ${OUTAGE_AT} a ${OUTAGE_AT + OUTAGE_FOR} de cada ciclo de ${CYCLE} s` : 'Sin cortes de red');

const timer = setInterval(async () => {
  await step();
  tick += 1;
  if (DURATION && tick >= DURATION) { clearInterval(timer); log('Fin de la simulación.'); }
}, 1000);
