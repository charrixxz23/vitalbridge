import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { AlertEngine } from '../../shared/alerts.js';
import { ingestBatch, parseBatch, resolveTime, ValidationError } from '../src/ingest.js';
import { toFhirBundle } from '../../shared/fhir.js';

const batch = (over = {}) => ({
  device_id: 'maletin-01',
  patient_id: 'P-1',
  boot_id: 'b1',
  uptime_ms: 100_000,
  queue_depth: 0,
  records: [
    { seq: 0, t: 40_000, kind: 'vitals', hr: 72, spo2: 97 },
    { seq: 1, t: 41_000, kind: 'vitals', hr: 73, spo2: 97 },
  ],
  ...over,
});

test('reenviar el mismo lote no duplica datos (idempotencia)', () => {
  const db = openDb();
  const engine = new AlertEngine();
  const first = ingestBatch(db, engine, batch(), 1_000_000);
  const again = ingestBatch(db, engine, batch(), 1_005_000);
  assert.deepEqual(first.response, { accepted: 2, duplicates: 0, alerts: 0 });
  assert.deepEqual(again.response, { accepted: 0, duplicates: 2, alerts: 0 });
  assert.equal(db.stats().records, 2);
});

test('misma secuencia en otro arranque NO es duplicado', () => {
  const db = openDb();
  const engine = new AlertEngine();
  ingestBatch(db, engine, batch(), 1_000_000);
  const r = ingestBatch(db, engine, batch({ boot_id: 'b2' }), 1_010_000);
  assert.equal(r.response.accepted, 2);
});

test('reconstruye la hora de medición desde el uptime del equipo', () => {
  const b = parseBatch(batch());
  // Medido en t=40 s, enviado con uptime=100 s → ocurrió 60 s antes de llegar.
  assert.deepEqual(resolveTime(b.records[0], b, 1_000_000), { ts: 940_000, ts_quality: 'derived' });
});

test('usa la hora absoluta si el equipo tenía NTP', () => {
  const epoch = Date.UTC(2026, 10, 4, 12, 0, 0);
  const b = parseBatch(batch({ records: [{ seq: 0, t: 1, epoch, kind: 'vitals', hr: 70 }] }));
  assert.deepEqual(resolveTime(b.records[0], b, epoch + 999_999), { ts: epoch, ts_quality: 'rtc' });
});

test('registros de un arranque anterior sin NTP quedan con hora de llegada', () => {
  const b = parseBatch(batch({ records: [{ seq: 5, t: 9_000, boot: 'viejo', kind: 'vitals', hr: 70 }] }));
  assert.deepEqual(resolveTime(b.records[0], b, 1_000_000), { ts: 1_000_000, ts_quality: 'arrival' });
});

test('una desaturación medida sin red genera alerta retroactiva al llegar', () => {
  const db = openDb();
  const engine = new AlertEngine({ consecutive: 2, retroactiveAfterMs: 30_000 });
  const r = ingestBatch(db, engine, batch({
    records: [
      { seq: 0, t: 10_000, kind: 'vitals', spo2: 84 },
      { seq: 1, t: 11_000, kind: 'vitals', spo2: 83 },
    ],
  }), 1_000_000);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].severity, 'critical');
  assert.equal(r.alerts[0].retroactive, 1);
  // La alerta se fecha con la lectura que la confirma (t=11 s → 89 s antes de llegar).
  assert.equal(r.alerts[0].ts, 1_000_000 - 89_000);
});

test('las alertas se evalúan en orden cronológico aunque el lote venga desordenado', () => {
  const db = openDb();
  const engine = new AlertEngine({ consecutive: 2 });
  const r = ingestBatch(db, engine, batch({
    records: [
      { seq: 2, t: 12_000, kind: 'vitals', hr: 80 },
      { seq: 0, t: 10_000, kind: 'vitals', hr: 130 },
      { seq: 1, t: 11_000, kind: 'vitals', hr: 130 },
    ],
  }), 1_000_000);
  assert.equal(r.alerts.length, 1);
});

test('valores imposibles se descartan sin tirar el lote', () => {
  const b = parseBatch(batch({ records: [{ seq: 0, t: 1, kind: 'vitals', hr: 999, spo2: 140, temp: 36.5 }] }));
  assert.equal(b.records[0].hr, null);
  assert.equal(b.records[0].spo2, null);
  assert.equal(b.records[0].temp, 36.5);
});

test('rechaza lotes mal formados', () => {
  assert.throws(() => parseBatch({}), ValidationError);
  assert.throws(() => parseBatch(batch({ device_id: '../../etc' })), ValidationError);
  assert.throws(() => parseBatch(batch({ records: [] })), ValidationError);
  assert.throws(() => parseBatch(batch({ records: [{ seq: 0, t: 1, kind: 'ecg', fs: 125, samples: [1, 2, 9999] }] })), ValidationError);
  assert.throws(() => parseBatch(batch({ records: [{ seq: -1, kind: 'vitals' }] })), ValidationError);
});

test('exporta Observations FHIR con códigos LOINC', () => {
  const db = openDb();
  ingestBatch(db, new AlertEngine(), batch(), Date.now());
  const device = db.listDevices()[0];
  const bundle = toFhirBundle({ device, rows: db.vitals(device.id), baseUrl: 'http://x' });
  assert.equal(bundle.resourceType, 'Bundle');
  assert.equal(bundle.total, 4); // 2 lecturas × (FC + SpO₂)
  const codes = new Set(bundle.entry.map((e) => e.resource.code.coding[0].code));
  assert.deepEqual([...codes].sort(), ['59408-5', '8867-4']);
  assert.equal(bundle.entry[0].resource.subject.reference, 'Patient/P-1');
});
