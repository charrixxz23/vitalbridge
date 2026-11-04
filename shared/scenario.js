// Escenario clínico de demostración, compartido por el simulador de Node y
// el modo demo del navegador.
//
//  0–28 s   normal
//  28–52 s  desaturación con taquicardia (SpO₂ → 83 %, FC → 128)
//  52–70 s  recuperación
//  30–80 s  febrícula que sube a ~38.3 °C
//  100–105 s electrodo de ECG suelto
//
// Por defecto el corte de red (20–80 s) tapa justo el episodio: así se ve
// que el equipo lo registra igual y que las alertas llegan, retroactivas,
// al reconectar.
import { mulberry32 } from './ecg.js';

export const DEFAULT_CYCLE_S = 150;
export const DEFAULT_OUTAGE = { at: 20, for: 60 };

const lerp = (a, b, x) => a + (b - a) * Math.max(0, Math.min(1, x));

export function makeScenario(seed = 7) {
  const rand = mulberry32(seed);
  return function scenario(s) {
    let hr = 72, spo2 = 97, temp = 36.7, lead_off = 0;
    if (s >= 28 && s < 40) { hr = lerp(72, 128, (s - 28) / 12); spo2 = lerp(97, 83, (s - 28) / 12); }
    else if (s >= 40 && s < 52) { hr = 128; spo2 = 83; }
    else if (s >= 52 && s < 70) { hr = lerp(128, 80, (s - 52) / 18); spo2 = lerp(83, 96, (s - 52) / 18); }
    if (s >= 30 && s < 80) temp = lerp(36.7, 38.3, (s - 30) / 25);
    if (s >= 100 && s < 105) lead_off = 1;
    return {
      hr: Math.round(hr + (rand() - 0.5) * 3),
      spo2: Math.min(100, Math.round(spo2 + (rand() - 0.5) * 1.5)),
      temp: Math.round((temp + (rand() - 0.5) * 0.1) * 10) / 10,
      lead_off,
    };
  };
}
