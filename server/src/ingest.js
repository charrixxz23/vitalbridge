// Ingesta de lotes store-and-forward.
//
// El equipo acumula registros mientras no hay red y los envía en lotes cuando
// vuelve la señal. Esta capa resuelve tres problemas de ese modelo:
//
//  - Duplicados: si se pierde la respuesta HTTP, el equipo reenvía el mismo lote.
//    Cada registro es único por (device_id, boot_id, seq) → reenviar es inocuo.
//  - Hora de la medición: el ESP32 no tiene RTC con batería. Si sincronizó NTP
//    manda `epoch`; si no, manda `t` (ms desde el arranque) y el servidor
//    reconstruye la hora con el `uptime_ms` del lote:
//        ts = llegada − (uptime_ms − t)
//    Para datos de un arranque anterior sin NTP no hay forma de saberlo: se
//    guardan con la hora de llegada y calidad 'arrival' (y se muestran así).
//  - Orden: las alertas se evalúan en orden cronológico de medición.

const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MIN_EPOCH = Date.UTC(2020, 0, 1);
const MAX_RECORDS = 500;
const MAX_ECG_SAMPLES = 5000;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const num = (v, min, max) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;

export function parseBatch(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('cuerpo JSON inválido');
  const { device_id, boot_id, patient_id = null, uptime_ms, queue_depth = 0, dropped = 0, firmware = null, records } = body;
  if (!ID_RE.test(device_id ?? '')) throw new ValidationError('device_id inválido');
  if (!ID_RE.test(boot_id ?? '')) throw new ValidationError('boot_id inválido');
  if (patient_id !== null && !ID_RE.test(patient_id)) throw new ValidationError('patient_id inválido');
  if (num(uptime_ms, 0, Number.MAX_SAFE_INTEGER) === null) throw new ValidationError('uptime_ms inválido');
  if (!Array.isArray(records) || records.length === 0) throw new ValidationError('records vacío');
  if (records.length > MAX_RECORDS) throw new ValidationError(`máximo ${MAX_RECORDS} registros por lote`);

  const parsed = records.map((r, i) => {
    if (!r || typeof r !== 'object') throw new ValidationError(`records[${i}] inválido`);
    if (!Number.isInteger(r.seq) || r.seq < 0) throw new ValidationError(`records[${i}].seq inválido`);
    const boot = r.boot ?? boot_id;
    if (!ID_RE.test(boot)) throw new ValidationError(`records[${i}].boot inválido`);
    const base = {
      seq: r.seq,
      boot,
      t: num(r.t, 0, Number.MAX_SAFE_INTEGER),
      epoch: num(r.epoch, MIN_EPOCH, Number.MAX_SAFE_INTEGER),
    };
    if (r.kind === 'vitals') {
      return {
        ...base,
        kind: 'vitals',
        // Valores fuera de rango fisiológico posible se descartan (sensor mal colocado).
        hr: num(r.hr, 20, 300),
        spo2: num(r.spo2, 50, 100),
        temp: num(r.temp, 25, 45),
        lead_off: r.lead_off ? 1 : 0,
      };
    }
    if (r.kind === 'ecg') {
      const fs = num(r.fs, 50, 1000);
      if (fs === null) throw new ValidationError(`records[${i}].fs inválido`);
      if (!Array.isArray(r.samples) || r.samples.length === 0 || r.samples.length > MAX_ECG_SAMPLES ||
          !r.samples.every((s) => Number.isInteger(s) && s >= 0 && s <= 4095)) {
        throw new ValidationError(`records[${i}].samples inválido (enteros ADC 0–4095)`);
      }
      return { ...base, kind: 'ecg', fs, samples: r.samples, lead_off: r.lead_off ? 1 : 0 };
    }
    throw new ValidationError(`records[${i}].kind debe ser 'vitals' o 'ecg'`);
  });

  return { device_id, boot_id, patient_id, uptime_ms, firmware, queue_depth: Math.max(0, queue_depth | 0), dropped: Math.max(0, dropped | 0), records: parsed };
}

export function resolveTime(record, batch, receivedAt) {
  if (record.epoch !== null) return { ts: Math.round(record.epoch), ts_quality: 'rtc' };
  if (record.t !== null && record.boot === batch.boot_id && record.t <= batch.uptime_ms) {
    return { ts: Math.round(receivedAt - (batch.uptime_ms - record.t)), ts_quality: 'derived' };
  }
  return { ts: receivedAt, ts_quality: 'arrival' };
}

/**
 * Inserta un lote y evalúa alertas. Devuelve lo necesario para responder al
 * equipo y para notificar al dashboard.
 */
export function ingestBatch(db, engine, body, receivedAt = Date.now()) {
  const batch = parseBatch(body);

  return db.transaction(() => {
    db.upsertDevice({
      id: batch.device_id,
      patient_id: batch.patient_id,
      firmware: batch.firmware,
      boot_id: batch.boot_id,
      now: receivedAt,
      queue_depth: batch.queue_depth,
      dropped: batch.dropped,
    });

    const accepted = [];
    let duplicates = 0;
    for (const r of batch.records) {
      const { ts, ts_quality } = resolveTime(r, batch, receivedAt);
      const row = {
        device_id: batch.device_id,
        patient_id: batch.patient_id,
        boot_id: r.boot,
        seq: r.seq,
        ts,
        ts_quality,
        received_at: receivedAt,
        kind: r.kind,
        hr: r.hr ?? null,
        spo2: r.spo2 ?? null,
        temp: r.temp ?? null,
        lead_off: r.lead_off,
        payload: r.kind === 'ecg' ? JSON.stringify({ fs: r.fs, samples: r.samples }) : null,
      };
      if (db.insertRecord(row)) accepted.push(row);
      else duplicates += 1;
    }

    accepted.sort((a, b) => a.ts - b.ts);
    const alerts = [];
    for (const row of accepted) {
      if (row.kind !== 'vitals') continue;
      const fired = engine.evaluate({
        deviceId: row.device_id,
        patientId: row.patient_id,
        ts: row.ts,
        receivedAt,
        hr: row.hr,
        spo2: row.spo2,
        temp: row.temp,
        lead_off: row.lead_off,
      });
      for (const a of fired) alerts.push({ id: db.insertAlert(a), ...a, acked_at: null });
    }

    return {
      response: { accepted: accepted.length, duplicates, alerts: alerts.length },
      accepted,
      alerts,
      device: {
        id: batch.device_id,
        patient_id: batch.patient_id,
        firmware: batch.firmware,
        last_boot_id: batch.boot_id,
        last_seen: receivedAt,
        queue_depth: batch.queue_depth,
        dropped: batch.dropped,
      },
    };
  });
}
