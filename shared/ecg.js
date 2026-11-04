// Generador de ECG sintético (derivación tipo I) para probar sin hardware.
// Cada latido es una suma de gaussianas P-Q-R-S-T (modelo simplificado
// inspirado en McSharry et al., 2003), más deriva de línea base y ruido.
// La salida imita al AD8232 leído por el ADC de 12 bits del ESP32.

const WAVES = [
  // [posición en fracción del RR, amplitud mV, ancho s]
  { at: 0.16, amp: 0.12, w: 0.025 }, // P
  { at: 0.27, amp: -0.10, w: 0.010 }, // Q
  { at: 0.30, amp: 1.10, w: 0.012 }, // R
  { at: 0.33, amp: -0.22, w: 0.012 }, // S
  { at: 0.55, amp: 0.30, w: 0.050 }, // T
];

const ADC_MID = 2048;
const COUNTS_PER_MV = 900;

export class EcgSynth {
  constructor({ fs = 125, seed = 42 } = {}) {
    this.fs = fs;
    this.t = 0;          // tiempo global (s)
    this.beatStart = 0;  // inicio del latido actual (s)
    this.rr = 60 / 72;
    this.rand = mulberry32(seed);
  }

  /** Genera `n` muestras con la frecuencia cardiaca indicada. */
  next(n, hr) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const phase = this.t - this.beatStart;
      if (phase >= this.rr) {
        this.beatStart += this.rr;
        // Variabilidad de la FC latido a latido (~3 %).
        this.rr = (60 / hr) * (1 + (this.rand() - 0.5) * 0.06);
      }
      const p = this.t - this.beatStart;
      let mv = 0;
      for (const wv of WAVES) {
        const center = wv.at * Math.min(this.rr, 1.0) + (wv === WAVES[4] ? Math.max(0, this.rr - 1) * 0.3 : 0);
        mv += wv.amp * Math.exp(-((p - center) ** 2) / (2 * wv.w ** 2));
      }
      mv += 0.08 * Math.sin(2 * Math.PI * 0.25 * this.t); // respiración
      mv += (this.rand() - 0.5) * 0.04;                   // ruido
      out[i] = Math.max(0, Math.min(4095, Math.round(ADC_MID + mv * COUNTS_PER_MV)));
      this.t += 1 / this.fs;
    }
    return out;
  }
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
