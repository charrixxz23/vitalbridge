# Protocolo de ingesta

Un único endpoint recibe lotes de registros desde el equipo:

```
POST /api/v1/ingest
Authorization: Bearer <token>
Content-Type: application/json
```

## Lote

```json
{
  "device_id": "maletin-esp32-01",
  "patient_id": "P-0001",
  "boot_id": "9f3a1c07",
  "firmware": "0.1.0",
  "uptime_ms": 734512,
  "queue_depth": 120,
  "dropped": 0,
  "records": [
    { "seq": 41, "boot": "9f3a1c07", "t": 650001, "kind": "vitals", "hr": 128, "spo2": 84, "lead_off": 0 },
    { "seq": 42, "boot": "9f3a1c07", "t": 650020, "epoch": 1793797092868, "kind": "ecg",
      "fs": 125, "lead_off": 0, "samples": [2051, 2049, 2060, "..."] }
  ]
}
```

| Campo | Significado |
|---|---|
| `boot_id` | Identificador aleatorio que cambia en cada arranque del ESP32. |
| `uptime_ms` | `millis()` en el momento de enviar el lote. |
| `queue_depth` | Registros que el equipo aún tiene en cola **después** de este lote. |
| `dropped` | Registros que el equipo descartó por memoria llena (acumulado). |
| `seq` | Secuencia monotónica dentro de un arranque. |
| `boot` | Arranque en el que se midió el registro (por defecto, `boot_id`). |
| `t` | `millis()` en el momento de la medición. |
| `epoch` | Hora absoluta en ms, solo si el equipo sincronizó NTP. |
| `kind` | `vitals` (FC, SpO₂, temperatura) o `ecg` (tira de muestras ADC 0–4095). |

## Garantías

**Idempotencia.** Cada registro es único por `(device_id, boot, seq)`. Si la
respuesta HTTP se pierde y el equipo reenvía el lote, el servidor responde
`200` con `duplicates > 0` y no guarda nada dos veces. Por eso el equipo puede
reintentar sin miedo.

**Hora de medición.** El ESP32 no tiene reloj con batería:

| Situación | Cómo se fecha | `ts_quality` |
|---|---|---|
| Hubo NTP | `epoch` tal cual | `rtc` |
| Mismo arranque, sin NTP | `llegada − (uptime_ms − t)` | `derived` |
| Arranque anterior, sin NTP | hora de llegada (se marca en FHIR) | `arrival` |

**Orden.** Las alertas se evalúan en orden cronológico de medición, aunque el
lote venga desordenado.

## Respuestas

| Código | Significado | Qué hace el equipo |
|---|---|---|
| `200` | `{ "accepted": n, "duplicates": m, "alerts": k }` | Borra el lote de su cola |
| `400` / `413` | Lote inválido o demasiado grande | Lo descarta (y lo cuenta) para no atascar la cola |
| `401` | Token incorrecto | Reintenta luego |
| `5xx` / sin respuesta | Error temporal | Reintenta luego |

## Otros endpoints

| Método y ruta | Uso |
|---|---|
| `GET /api/v1/stream` | Server-Sent Events: `snapshot`, `device`, `vitals`, `ecg`, `alert`, `ack`, `stats` |
| `GET /api/v1/devices` | Equipos y su estado (`online`, `queue_depth`, `dropped`) |
| `GET /api/v1/devices/:id/vitals?minutes=30` | Historial de signos vitales |
| `GET /api/v1/devices/:id/ecg/latest` | Última tira de ECG |
| `GET /api/v1/alerts?limit=50` | Alertas recientes |
| `POST /api/v1/alerts/:id/ack` | Confirmar una alerta |
| `GET /fhir/Observation?device=ID&minutes=60` | Bundle HL7 FHIR R4 con Observations LOINC |
| `GET /healthz` | Estado del servidor |
