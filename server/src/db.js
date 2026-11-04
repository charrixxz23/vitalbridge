// Persistencia con el SQLite integrado de Node (node:sqlite, Node >= 22.13).
// Cero dependencias externas: el gateway debe poder correr en una laptop vieja
// de un centro de salud sin `npm install`.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  patient_id    TEXT,
  firmware      TEXT,
  last_boot_id  TEXT,
  last_seen     INTEGER,          -- epoch ms (reloj del servidor)
  queue_depth   INTEGER DEFAULT 0, -- registros que el equipo aún tiene en cola
  dropped       INTEGER DEFAULT 0  -- registros que el equipo descartó por memoria llena
);

-- Cada registro es único por (equipo, arranque, secuencia): reenviar un lote
-- después de un corte de red nunca duplica datos (ingesta idempotente).
CREATE TABLE IF NOT EXISTS records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     TEXT NOT NULL REFERENCES devices(id),
  patient_id    TEXT,
  boot_id       TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  ts            INTEGER NOT NULL, -- epoch ms en que se MIDIÓ
  ts_quality    TEXT NOT NULL,    -- 'rtc' | 'derived' | 'arrival'
  received_at   INTEGER NOT NULL, -- epoch ms en que LLEGÓ
  kind          TEXT NOT NULL,    -- 'vitals' | 'ecg'
  hr            REAL,
  spo2          REAL,
  temp          REAL,
  lead_off      INTEGER,
  payload       TEXT,             -- JSON (tira de ECG)
  UNIQUE (device_id, boot_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_records_dev_ts ON records(device_id, kind, ts);

CREATE TABLE IF NOT EXISTS alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     TEXT NOT NULL,
  patient_id    TEXT,
  rule          TEXT NOT NULL,
  severity      TEXT NOT NULL,    -- 'warning' | 'critical'
  value         REAL,
  message       TEXT NOT NULL,
  ts            INTEGER NOT NULL, -- cuándo ocurrió
  received_at   INTEGER NOT NULL, -- cuándo se supo
  retroactive   INTEGER NOT NULL DEFAULT 0,
  acked_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts DESC);
`;

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const st = {
    upsertDevice: db.prepare(`
      INSERT INTO devices (id, patient_id, firmware, last_boot_id, last_seen, queue_depth, dropped)
      VALUES (:id, :patient_id, :firmware, :boot_id, :now, :queue_depth, :dropped)
      ON CONFLICT(id) DO UPDATE SET
        patient_id = excluded.patient_id,
        firmware = COALESCE(excluded.firmware, devices.firmware),
        last_boot_id = excluded.last_boot_id,
        last_seen = excluded.last_seen,
        queue_depth = excluded.queue_depth,
        dropped = excluded.dropped`),
    insertRecord: db.prepare(`
      INSERT OR IGNORE INTO records
        (device_id, patient_id, boot_id, seq, ts, ts_quality, received_at, kind, hr, spo2, temp, lead_off, payload)
      VALUES
        (:device_id, :patient_id, :boot_id, :seq, :ts, :ts_quality, :received_at, :kind, :hr, :spo2, :temp, :lead_off, :payload)`),
    insertAlert: db.prepare(`
      INSERT INTO alerts (device_id, patient_id, rule, severity, value, message, ts, received_at, retroactive)
      VALUES (:device_id, :patient_id, :rule, :severity, :value, :message, :ts, :received_at, :retroactive)`),
    listDevices: db.prepare(`SELECT * FROM devices ORDER BY id`),
    vitals: db.prepare(`
      SELECT ts, ts_quality, hr, spo2, temp, lead_off, received_at FROM records
      WHERE device_id = ? AND kind = 'vitals' AND ts >= ?
      ORDER BY ts DESC LIMIT ?`),
    lastEcg: db.prepare(`
      SELECT ts, payload FROM records
      WHERE device_id = ? AND kind = 'ecg' ORDER BY ts DESC LIMIT 1`),
    alerts: db.prepare(`SELECT * FROM alerts ORDER BY ts DESC LIMIT ?`),
    ackAlert: db.prepare(`UPDATE alerts SET acked_at = ? WHERE id = ? AND acked_at IS NULL`),
    stats: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM records) AS records,
        (SELECT COUNT(*) FROM records WHERE received_at - ts > 5000) AS backfilled,
        (SELECT COUNT(*) FROM alerts) AS alerts,
        (SELECT COUNT(*) FROM alerts WHERE retroactive = 1) AS retroactive_alerts`),
  };

  return {
    raw: db,
    transaction(fn) {
      db.exec('BEGIN');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    upsertDevice: (d) => st.upsertDevice.run(d),
    insertRecord: (r) => st.insertRecord.run(r).changes === 1,
    insertAlert: (a) => Number(st.insertAlert.run(a).lastInsertRowid),
    listDevices: () => st.listDevices.all(),
    vitals: (deviceId, since = 0, limit = 500) => st.vitals.all(deviceId, since, limit).reverse(),
    lastEcg(deviceId) {
      const row = st.lastEcg.get(deviceId);
      return row ? { ts: row.ts, ...JSON.parse(row.payload) } : null;
    },
    alerts: (limit = 50) => st.alerts.all(limit),
    ackAlert: (id, now = Date.now()) => st.ackAlert.run(now, id).changes === 1,
    stats: () => st.stats.get(),
    close: () => db.close(),
  };
}
