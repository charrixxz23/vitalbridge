// Motor de alertas por umbral, puro y sin E/S para poder probarlo aislado.
//
// Dos ideas clave:
//  1. Antirrebote: una alerta se dispara solo tras N lecturas consecutivas
//     fuera de rango (un dedo que se mueve en el oxímetro no es una hipoxemia).
//  2. Alertas retroactivas: si la lectura que dispara la alerta llega mucho
//     después de haberse medido (porque el maletín estuvo sin internet), la
//     alerta se marca `retroactive` para que el médico sepa que ya ocurrió.
//
// Umbrales orientativos para una demo. NO son criterio clínico validado.

export const RULES = [
  {
    id: 'spo2_low', field: 'spo2', label: 'SpO₂ baja', unit: '%',
    level: (v) => (v < 85 ? 'critical' : v < 90 ? 'warning' : null),
  },
  {
    id: 'hr_high', field: 'hr', label: 'Taquicardia', unit: 'lpm',
    level: (v) => (v > 150 ? 'critical' : v > 120 ? 'warning' : null),
  },
  {
    id: 'hr_low', field: 'hr', label: 'Bradicardia', unit: 'lpm',
    level: (v) => (v < 40 ? 'critical' : v < 50 ? 'warning' : null),
  },
  {
    id: 'temp_high', field: 'temp', label: 'Fiebre', unit: '°C',
    level: (v) => (v >= 39.5 ? 'critical' : v >= 38 ? 'warning' : null),
  },
  {
    id: 'lead_off', field: 'lead_off', label: 'Electrodo de ECG desconectado', unit: '',
    level: (v) => (v ? 'warning' : null),
  },
];

const RANK = { null: 0, warning: 1, critical: 2 };

export class AlertEngine {
  /**
   * @param {object} opts
   * @param {number} opts.consecutive       lecturas seguidas necesarias para disparar / resolver
   * @param {number} opts.retroactiveAfterMs a partir de qué retraso una alerta es "retroactiva"
   */
  constructor({ consecutive = 2, retroactiveAfterMs = 10_000, rules = RULES } = {}) {
    this.consecutive = consecutive;
    this.retroactiveAfterMs = retroactiveAfterMs;
    this.rules = rules;
    this.state = new Map(); // `${device}:${rule}` -> { active, candidate, count, normalCount }
  }

  /**
   * Evalúa una lectura de signos vitales. Debe llamarse en orden cronológico
   * por equipo. Devuelve las alertas nuevas (escaladas) que hay que emitir.
   */
  evaluate({ deviceId, patientId, ts, receivedAt = Date.now(), ...vitals }) {
    const fired = [];
    for (const rule of this.rules) {
      const value = vitals[rule.field];
      if (value === null || value === undefined) continue;

      const key = `${deviceId}:${rule.id}`;
      const s = this.state.get(key) ?? { active: null, candidate: null, count: 0, normalCount: 0 };
      const level = rule.level(value);

      if (level === null) {
        s.candidate = null;
        s.count = 0;
        if (s.active && ++s.normalCount >= this.consecutive) {
          s.active = null; // resuelta: la próxima vez que salga de rango vuelve a avisar
          s.normalCount = 0;
        }
      } else {
        s.normalCount = 0;
        if (RANK[level] > RANK[s.active]) {
          // Racha de lecturas peores que la alerta activa. La severidad que se
          // dispara es la MÍNIMA sostenida en la racha: un solo pico crítico
          // tras una advertencia no basta para declarar un evento crítico.
          if (s.candidate) {
            s.count += 1;
            if (RANK[level] < RANK[s.candidate]) s.candidate = level;
          } else {
            s.candidate = level;
            s.count = 1;
          }

          if (s.count >= this.consecutive) {
            s.active = s.candidate;
            s.candidate = null;
            s.count = 0;
            const delay = receivedAt - ts;
            fired.push({
              device_id: deviceId,
              patient_id: patientId ?? null,
              rule: rule.id,
              severity: s.active,
              value,
              message: formatMessage(rule, value, s.active),
              ts,
              received_at: receivedAt,
              retroactive: delay > this.retroactiveAfterMs ? 1 : 0,
            });
          }
        } else {
          // Sigue fuera de rango pero no peor que lo ya avisado: se rompe la racha de escalada.
          s.candidate = null;
          s.count = 0;
        }
      }
      this.state.set(key, s);
    }
    return fired;
  }
}

function formatMessage(rule, value, severity) {
  const tag = severity === 'critical' ? 'crítico' : 'advertencia';
  if (rule.id === 'lead_off') return `${rule.label} (${tag})`;
  const v = Number.isInteger(value) ? value : value.toFixed(1);
  return `${rule.label}: ${v} ${rule.unit} (${tag})`;
}
