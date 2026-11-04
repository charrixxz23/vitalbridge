// VitalBridge — servidor de ingesta, alertas y dashboard.
// Solo módulos integrados de Node: http, SQLite y Server-Sent Events.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

import { openDb } from './db.js';
import { AlertEngine } from '../../shared/alerts.js';
import { ingestBatch, ValidationError } from './ingest.js';
import { toFhirBundle } from '../../shared/fhir.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const STATIC_DIR = join(ROOT, 'dashboard');
const SHARED_DIR = join(ROOT, 'shared');
const MAX_BODY = 1_000_000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export function createApp({
  dbPath = ':memory:',
  tokens = ['demo-token'],
  offlineAfterMs = 15_000,
  engine = new AlertEngine(),
  log = () => {},
} = {}) {
  const db = openDb(dbPath);
  const clients = new Set();
  const tokenBufs = tokens.map((t) => Buffer.from(t));
  const online = new Map(); // device_id -> boolean (último estado anunciado)

  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event, data) => { for (const res of clients) send(res, event, data); };

  const withStatus = (d, now = Date.now()) => ({ ...d, online: now - d.last_seen < offlineAfterMs });

  // Detecta equipos que dejaron de reportar (el maletín perdió señal).
  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const d of db.listDevices()) {
      const dev = withStatus(d, now);
      if (online.get(dev.id) !== dev.online) {
        online.set(dev.id, dev.online);
        broadcast('device', dev);
      }
    }
  }, 2_000);
  watchdog.unref();

  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15_000);
  heartbeat.unref();

  function authorized(req) {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer (.+)$/.exec(header);
    if (!m) return false;
    const given = Buffer.from(m[1]);
    return tokenBufs.some((t) => t.length === given.length && timingSafeEqual(t, given));
  }

  async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error('lote demasiado grande'), { status: 413 });
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ValidationError('JSON mal formado');
    }
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function serveStatic(res, pathname) {
    // /shared/* son los módulos puros que también usa el navegador (modo demo).
    const isShared = pathname.startsWith('/shared/');
    const base = isShared ? SHARED_DIR : STATIC_DIR;
    const rel = pathname === '/' ? 'index.html' : pathname.slice(isShared ? '/shared/'.length : 1);
    const file = normalize(join(base, rel));
    if (!file.startsWith(base + sep)) return json(res, 404, { error: 'no encontrado' });
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      json(res, 404, { error: 'no encontrado' });
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;
    const route = `${req.method} ${pathname}`;
    let m;

    if (route === 'GET /healthz') return json(res, 200, { ok: true });

    if (route === 'POST /api/v1/ingest') {
      if (!authorized(req)) return json(res, 401, { error: 'token inválido' });
      const body = await readJson(req);
      const result = ingestBatch(db, engine, body);
      const now = Date.now();

      online.set(result.device.id, true);
      broadcast('device', withStatus(result.device, now));
      for (const r of result.accepted) {
        if (r.kind === 'vitals') {
          broadcast('vitals', { device_id: r.device_id, ts: r.ts, ts_quality: r.ts_quality, received_at: r.received_at, hr: r.hr, spo2: r.spo2, temp: r.temp, lead_off: r.lead_off });
        } else if (now - r.ts < 10_000) {
          // Solo se anima el ECG "en vivo"; las tiras atrasadas quedan guardadas.
          const { fs, samples } = JSON.parse(r.payload);
          broadcast('ecg', { device_id: r.device_id, ts: r.ts, fs, samples, lead_off: r.lead_off });
        }
      }
      for (const a of result.alerts) broadcast('alert', a);
      broadcast('stats', db.stats());

      const late = result.accepted.filter((r) => r.received_at - r.ts > 5_000).length;
      log(`ingest ${result.device.id}: +${result.response.accepted} (dup ${result.response.duplicates}` +
        `${late ? `, ${late} atrasados` : ''}${result.alerts.length ? `, ${result.alerts.length} alertas` : ''}) cola=${result.device.queue_depth}`);
      return json(res, 200, result.response);
    }

    if (route === 'GET /api/v1/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      const now = Date.now();
      send(res, 'snapshot', {
        devices: db.listDevices().map((d) => withStatus(d, now)),
        alerts: db.alerts(50),
        stats: db.stats(),
      });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (route === 'GET /api/v1/devices') return json(res, 200, db.listDevices().map((d) => withStatus(d)));

    if (req.method === 'GET' && (m = /^\/api\/v1\/devices\/([\w.-]+)\/vitals$/.exec(pathname))) {
      const minutes = Math.min(Number(url.searchParams.get('minutes')) || 30, 24 * 60);
      return json(res, 200, db.vitals(m[1], Date.now() - minutes * 60_000, 5000));
    }

    if (req.method === 'GET' && (m = /^\/api\/v1\/devices\/([\w.-]+)\/ecg\/latest$/.exec(pathname))) {
      const ecg = db.lastEcg(m[1]);
      return ecg ? json(res, 200, ecg) : json(res, 404, { error: 'sin ECG' });
    }

    if (route === 'GET /api/v1/alerts') {
      return json(res, 200, db.alerts(Math.min(Number(url.searchParams.get('limit')) || 50, 500)));
    }

    if (req.method === 'POST' && (m = /^\/api\/v1\/alerts\/(\d+)\/ack$/.exec(pathname))) {
      const ok = db.ackAlert(Number(m[1]));
      if (ok) broadcast('ack', { id: Number(m[1]), acked_at: Date.now() });
      return json(res, ok ? 200 : 404, { ok });
    }

    if (route === 'GET /api/v1/stats') return json(res, 200, db.stats());

    if (route === 'GET /fhir/Observation') {
      const deviceId = url.searchParams.get('device');
      const device = db.listDevices().find((d) => d.id === deviceId);
      if (!device) return json(res, 404, { error: 'equipo no encontrado (?device=ID)' });
      const minutes = Math.min(Number(url.searchParams.get('minutes')) || 60, 24 * 60);
      const rows = db.vitals(device.id, Date.now() - minutes * 60_000, 5000);
      res.writeHead(200, { 'content-type': 'application/fhir+json; charset=utf-8' });
      return res.end(JSON.stringify(toFhirBundle({ device, rows, baseUrl: `http://${req.headers.host}` }), null, 2));
    }

    if (req.method === 'GET') return serveStatic(res, pathname);
    return json(res, 404, { error: 'no encontrado' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status ?? 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: err.message });
      else res.end();
    });
  });

  server.on('close', () => {
    clearInterval(watchdog);
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    db.close();
  });

  return { server, db };
}

function lanAddresses() {
  return Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

// Arranque directo: `npm start`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  const tokens = (process.env.INGEST_TOKENS ?? 'demo-token').split(',').map((s) => s.trim()).filter(Boolean);
  const dbPath = process.env.DB_PATH ?? join(ROOT, 'data', 'vitalbridge.db');
  const { server } = createApp({ dbPath, tokens, log: (msg) => console.log(new Date().toLocaleTimeString(), msg) });

  server.listen(port, '0.0.0.0', () => {
    console.log(`\nVitalBridge escuchando en el puerto ${port}`);
    console.log(`  Dashboard:  http://localhost:${port}`);
    for (const ip of lanAddresses()) console.log(`  Para el ESP32 (misma red): http://${ip}:${port}/api/v1/ingest`);
    if (tokens.includes('demo-token')) console.log('  ⚠  Usando el token de demo. Define INGEST_TOKENS para algo real.');
    console.log('');
  });
}
