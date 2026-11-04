// Dashboard en tiempo real. Sin frameworks ni build.
// Funciona contra el servidor real (SSE) o en modo demo 100 % en el navegador.
import { pickTransport } from './transport.js';

const $ = (sel) => document.querySelector(sel);
const TREND_MS = 10 * 60_000;
const LATE_MS = 5_000;       // en vivo llega en ~1 s; más de 5 s de retraso → vino de la cola
const STALE_MS = 10_000;     // sin lecturas en vivo → números atenuados

const state = {
  devices: new Map(),
  selected: null,
  vitals: [],                // tendencia del equipo seleccionado
  alerts: [],
  lastLiveAt: 0,
  syncRun: { count: 0, from: null, to: null, timer: null },
};

const fmtTime = (ts) => new Date(ts).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fmtAgo = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

// ── Clasificación local (misma que el servidor, solo para colorear) ──────────
const level = {
  hr: (v) => (v > 150 || v < 40 ? 'critical' : v > 120 || v < 50 ? 'warning' : null),
  spo2: (v) => (v < 85 ? 'critical' : v < 90 ? 'warning' : null),
  temp: (v) => (v >= 39.5 ? 'critical' : v >= 38 ? 'warning' : null),
};

// ═════════════════════════════════════════════════════════════════════════════
// Conexión SSE
// ═════════════════════════════════════════════════════════════════════════════
let transport;

function connect() {
  const handlers = {
    snapshot({ devices, alerts, stats }) {
      state.devices = new Map(devices.map((d) => [d.id, d]));
      state.alerts = alerts;
      renderDevices();
      renderAlerts();
      renderStats(stats);
      if (!state.selected && devices.length) select(devices[0].id);
      else if (state.selected) select(state.selected);
    },
    device(d) {
      const prev = state.devices.get(d.id);
      state.devices.set(d.id, { ...prev, ...d });
      if (!prev) {
        renderDevices();
        if (!state.selected) select(d.id);
      }
      if (d.id === state.selected) renderLink();
    },
    vitals(v) {
      if (v.device_id !== state.selected) return;
      addVital(v);
      const late = v.received_at - v.ts > LATE_MS;
      if (late) noteRecovered(v.ts);
      else {
        state.lastLiveAt = Date.now();
        renderVitals(v);
      }
    },
    ecg(e) {
      if (e.device_id === state.selected) ecg.feed(e.samples, e.fs, e.lead_off);
    },
    alert(a) {
      state.alerts.unshift(a);
      state.alerts = state.alerts.slice(0, 100);
      renderAlerts(a.id);
    },
    ack({ id, acked_at }) {
      const a = state.alerts.find((x) => x.id === id);
      if (a) { a.acked_at = acked_at; renderAlerts(); }
    },
    stats: renderStats,
  };
  transport.subscribe(handlers, () => setPill('pill-idle', 'Reconectando con el servidor…'));
}

async function select(id) {
  state.selected = id;
  $('#device').value = id;
  const d = state.devices.get(id);
  $('#patient').textContent = d?.patient_id ? `Paciente ${d.patient_id}` : '';
  ecg.reset();
  const rows = await transport.vitals(id, 10);
  state.vitals = rows;
  const last = rows.at(-1);
  if (last) {
    if (Date.now() - last.ts < STALE_MS) state.lastLiveAt = last.ts;
    renderVitals(last);
  }
  renderLink();
  drawTrend();
}

function addVital(v) {
  // Inserción ordenada: los datos de la cola llegan con horas del pasado.
  const arr = state.vitals;
  let i = arr.length;
  while (i > 0 && arr[i - 1].ts > v.ts) i--;
  arr.splice(i, 0, v);
  const cutoff = Date.now() - TREND_MS;
  while (arr.length && arr[0].ts < cutoff) arr.shift();
}

// ═════════════════════════════════════════════════════════════════════════════
// Render
// ═════════════════════════════════════════════════════════════════════════════
function renderDevices() {
  const sel = $('#device');
  const ids = [...state.devices.keys()];
  if (!ids.length) return;
  sel.innerHTML = ids.map((id) => `<option value="${id}">${id}</option>`).join('');
  if (state.selected) sel.value = state.selected;
}
$('#device').addEventListener('change', (e) => select(e.target.value));

function setPill(cls, text) {
  const el = $('#link');
  el.className = `pill ${cls}`;
  el.textContent = text;
}

function renderLink() {
  const d = state.devices.get(state.selected);
  const banner = $('#sync-banner');
  if (!d) return setPill('pill-idle', 'Sin equipos');

  if (!d.online) {
    setPill('pill-offline', `Sin señal · ${fmtAgo(Date.now() - d.last_seen)}`);
    banner.hidden = false;
    banner.className = 'banner offline';
    banner.textContent = `El maletín no reporta desde las ${fmtTime(d.last_seen)}. ` +
      'Sigue midiendo y guardando en su memoria; los datos aparecerán aquí, con su hora real, cuando recupere señal.';
  } else if (d.queue_depth > 2) {
    setPill('pill-sync', `Sincronizando · ${d.queue_depth} en cola`);
  } else {
    setPill('pill-online', 'En línea');
    if (banner.classList.contains('offline')) banner.hidden = true;
  }
  // Sin señal no sabemos cuánto lleva acumulado: no mostrar un número viejo.
  $('#s-queue').textContent = d.online ? (d.queue_depth ?? 0) : '—';
  ecg.setOffline(!d.online);
}
setInterval(() => { renderLink(); renderStaleness(); drawTrend(); renderDemoBar(); }, 1000);

$('#fhir').addEventListener('click', (e) => {
  e.preventDefault();
  if (state.selected) transport.openFhir(state.selected);
});

// ── Controles del modo demo ──────────────────────────────────────────────────
function renderDemoBar() {
  if (transport?.kind !== 'demo') return;
  const net = transport.network;
  $('#net-toggle').textContent = net.offline ? 'Restaurar red' : 'Cortar red';
  $('#net-toggle').classList.toggle('danger', !net.offline);
  $('#net-auto').hidden = !net.manual;
  $('#net-hint').textContent = net.manual
    ? 'Control manual de la red'
    : `Corte automático: ${net.offline ? 'vuelve' : 'se cae'} en ${net.secondsToScheduledChange()} s`;
}
$('#net-toggle').addEventListener('click', () => { transport.network.toggle(); renderDemoBar(); renderLink(); });
$('#net-auto').addEventListener('click', () => { transport.network.auto(); renderDemoBar(); renderLink(); });

function noteRecovered(ts) {
  const r = state.syncRun;
  r.count += 1;
  r.from = r.from === null ? ts : Math.min(r.from, ts);
  r.to = r.to === null ? ts : Math.max(r.to, ts);
  const banner = $('#sync-banner');
  banner.hidden = false;
  banner.className = 'banner sync';
  banner.textContent = `↺ Se recuperaron ${r.count} mediciones tomadas sin conexión ` +
    `(${fmtTime(r.from)} – ${fmtTime(r.to)}). Ya están en la tendencia y en las alertas.`;
  clearTimeout(r.timer);
  r.timer = setTimeout(() => {
    banner.hidden = true;
    Object.assign(r, { count: 0, from: null, to: null });
  }, 15_000);
}

function renderVitals(v) {
  const set = (id, value, lv, digits = 0) => {
    const el = $(id);
    el.querySelector('b').textContent = value === null || value === undefined ? '--' : value.toFixed(digits);
    el.classList.remove('warning', 'critical');
    if (lv) el.classList.add(lv);
  };
  set('#v-hr', v.hr, v.hr != null && level.hr(v.hr));
  set('#v-spo2', v.spo2, v.spo2 != null && level.spo2(v.spo2));
  set('#v-temp', v.temp, v.temp != null && level.temp(v.temp), 1);
}

function renderStaleness() {
  const stale = Date.now() - state.lastLiveAt > STALE_MS;
  document.querySelectorAll('.vital').forEach((el) => el.classList.toggle('stale', stale));
}

function renderAlerts(highlightId) {
  const list = $('#alerts');
  const open = state.alerts.filter((a) => !a.acked_at).length;
  $('#alert-count').textContent = state.alerts.length ? `${open} sin confirmar` : '';
  if (!state.alerts.length) {
    list.innerHTML = '<li class="empty">Sin alertas.</li>';
    return;
  }
  list.innerHTML = state.alerts.map((a) => {
    const delay = a.received_at - a.ts;
    return `<li class="alert ${a.severity} ${a.acked_at ? 'acked' : ''}" data-id="${a.id}">
      <span class="msg">${escapeHtml(a.message)}</span>
      <span class="when">${escapeHtml(a.device_id)} · ${fmtTime(a.ts)}</span>
      ${a.acked_at ? '' : `<button type="button" data-ack="${a.id}">Confirmar</button>`}
      ${a.retroactive ? `<span class="retro">Retroactiva: ocurrió sin conexión, se supo ${fmtAgo(delay)} después</span>` : ''}
    </li>`;
  }).join('');
  if (highlightId) list.querySelector(`[data-id="${highlightId}"]`)?.animate(
    [{ background: 'rgb(239 68 68 / .35)' }, { background: 'transparent' }], { duration: 1500 });
}
$('#alerts').addEventListener('click', (e) => {
  const id = e.target.dataset?.ack;
  if (id) transport.ack(Number(id));
});

function renderStats(s) {
  $('#s-records').textContent = s.records.toLocaleString('es-PA');
  $('#s-backfilled').textContent = s.backfilled.toLocaleString('es-PA');
  $('#s-retro').textContent = s.retroactive_alerts;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ═════════════════════════════════════════════════════════════════════════════
// ECG: barrido tipo monitor a 25 mm/s con barra de borrado
// ═════════════════════════════════════════════════════════════════════════════
const ecg = (() => {
  const canvas = $('#ecg');
  const ctx = canvas.getContext('2d');
  const overlay = $('#ecg-overlay');
  const WINDOW_S = 6;          // segundos visibles
  const MV_RANGE = 1.6;        // ±mV visibles
  const ADC_MID = 2048, COUNTS_PER_MV = 900;
  let W = 0, H = 0, dpr = 1;
  let queue = [];
  let fs = 125;
  let x = 0, lastY = null;
  let playing = false;
  let leadOff = false, offline = false;
  let lastFrame = performance.now();
  let carry = 0;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    grid(0, W);
    x = 0; lastY = null;
  }

  // Cuadrícula de papel de ECG: 0.2 s y 0.5 mV.
  function grid(x0, w) {
    ctx.fillStyle = '#05080c';
    ctx.fillRect(x0, 0, w, H);
    const pxPerS = W / WINDOW_S;
    const pxPerMv = H / (2 * MV_RANGE);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, w, H);
    ctx.clip();
    for (let t = 0; t <= WINDOW_S; t += 0.04) {
      const gx = Math.round(t * pxPerS) + 0.5;
      if (gx < x0 - 1 || gx > x0 + w + 1) continue;
      const major = Math.abs((t / 0.2) - Math.round(t / 0.2)) < 1e-6;
      ctx.strokeStyle = major ? 'rgba(52, 211, 153, 0.11)' : 'rgba(52, 211, 153, 0.025)';
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
    }
    for (let mv = -MV_RANGE; mv <= MV_RANGE + 1e-6; mv += 0.1) {
      const gy = Math.round(H / 2 - mv * pxPerMv) + 0.5;
      const major = Math.abs((mv / 0.5) - Math.round(mv / 0.5)) < 1e-6;
      ctx.strokeStyle = major ? 'rgba(52, 211, 153, 0.11)' : 'rgba(52, 211, 153, 0.025)';
      ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x0 + w, gy); ctx.stroke();
    }
    ctx.restore();
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;

    // Buffer de reproducción: arrancar con ~2.5 s acumulados para absorber la
    // latencia de red (llegan tiras de 2 s), y recortar si se acumula de más.
    if (!playing && queue.length >= fs * 2.5) playing = true;
    if (queue.length > fs * 6) queue = queue.slice(queue.length - fs * 3);

    if (playing) {
      carry += dt * fs;
      let n = Math.floor(carry);
      carry -= n;
      const pxPerSample = W / (WINDOW_S * fs);
      const pxPerMv = H / (2 * MV_RANGE);
      ctx.lineWidth = 2.2;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#6ee7b7';
      ctx.shadowColor = 'rgba(52, 211, 153, 0.7)';
      ctx.shadowBlur = 4;
      while (n-- > 0) {
        if (!queue.length) { playing = false; lastY = null; break; }
        const s = queue.shift();
        const y = H / 2 - ((s - ADC_MID) / COUNTS_PER_MV) * pxPerMv;
        const nx = x + pxPerSample;
        grid(nx, 14); // barra de borrado delante del trazo
        if (lastY !== null) {
          ctx.beginPath(); ctx.moveTo(x, lastY); ctx.lineTo(nx, y); ctx.stroke();
        }
        x = nx; lastY = y;
        if (x >= W) { x = 0; lastY = null; grid(0, 14); }
      }
      ctx.shadowBlur = 0;
    }
    updateOverlay();
    requestAnimationFrame(frame);
  }

  function updateOverlay() {
    let msg = '';
    if (offline) msg = 'SIN SEÑAL · el equipo guarda tiras de ECG de 10 s cada 30 s';
    else if (leadOff) msg = 'ELECTRODO DESCONECTADO · revise RA / LA / RL';
    else if (!playing) msg = queue.length ? 'Sincronizando ECG…' : 'Esperando ECG…';
    overlay.hidden = !msg;
    overlay.textContent = msg;
  }

  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);

  return {
    feed(samples, sampleRate, lo) {
      fs = sampleRate;
      leadOff = !!lo;
      queue.push(...samples);
    },
    reset() { queue = []; playing = false; resize(); },
    setOffline(v) {
      if (v && !offline) { queue = []; playing = false; }
      offline = v;
    },
  };
})();

// ═════════════════════════════════════════════════════════════════════════════
// Tendencia: FC y SpO₂, con franjas donde los datos vinieron de la cola
// ═════════════════════════════════════════════════════════════════════════════
const trendCanvas = $('#trend');
const tctx = trendCanvas.getContext('2d');

function drawTrend() {
  const dpr = window.devicePixelRatio || 1;
  const r = trendCanvas.getBoundingClientRect();
  if (!r.width) return;
  if (trendCanvas.width !== Math.round(r.width * dpr)) {
    trendCanvas.width = Math.round(r.width * dpr);
    trendCanvas.height = Math.round(r.height * dpr);
  }
  const ctx = tctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width, H = r.height;
  const padL = 38, padR = 38, padT = 8, padB = 22;
  const pw = W - padL - padR, ph = H - padT - padB;
  const now = Date.now(), t0 = now - TREND_MS;
  const X = (ts) => padL + ((ts - t0) / TREND_MS) * pw;
  const yHr = (v) => padT + ph - ((v - 30) / (180 - 30)) * ph;     // 30–180 lpm
  const ySp = (v) => padT + ph - ((v - 70) / (100 - 70)) * ph;     // 70–100 %

  ctx.clearRect(0, 0, W, H);
  ctx.font = '11px system-ui, sans-serif';

  // Franjas "recuperado de la cola"
  ctx.fillStyle = 'rgba(167, 139, 250, 0.14)';
  let runStart = null, prev = null;
  for (const v of state.vitals) {
    const late = v.received_at - v.ts > LATE_MS;
    if (late && runStart === null) runStart = v.ts;
    if (!late && runStart !== null) { ctx.fillRect(X(runStart), padT, X(prev.ts) - X(runStart), ph); runStart = null; }
    prev = v;
  }
  if (runStart !== null && prev) ctx.fillRect(X(runStart), padT, X(prev.ts) - X(runStart), ph);

  // Rejilla y ejes
  ctx.strokeStyle = '#1f2a37';
  ctx.fillStyle = '#8b98a8';
  ctx.lineWidth = 1;
  for (let m = 0; m <= 10; m += 2) {
    const gx = Math.round(X(t0 + m * 60_000)) + 0.5;
    ctx.beginPath(); ctx.moveTo(gx, padT); ctx.lineTo(gx, padT + ph); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText(m === 10 ? 'ahora' : `-${10 - m} min`, gx, H - 6);
  }
  for (const hr of [50, 90, 120, 150]) {
    const gy = Math.round(yHr(hr)) + 0.5;
    ctx.setLineDash(hr === 50 || hr === 120 ? [4, 4] : []);
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(padL + pw, gy); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillStyle = '#34d399'; ctx.fillText(hr, padL - 6, gy + 4);
  }
  ctx.setLineDash([]);
  for (const sp of [80, 90, 100]) {
    ctx.textAlign = 'left'; ctx.fillStyle = '#38bdf8'; ctx.fillText(`${sp}%`, padL + pw + 6, ySp(sp) + 4);
  }

  // Series (se cortan si hay un hueco > 5 s sin datos)
  const line = (field, y, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let last = null;
    for (const v of state.vitals) {
      const val = v[field];
      if (val === null || val === undefined) { last = null; continue; }
      const px = X(v.ts), py = y(val);
      if (last && v.ts - last.ts < 5000) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      last = v;
    }
    ctx.stroke();
  };
  ctx.save();
  ctx.beginPath(); ctx.rect(padL, padT, pw, ph); ctx.clip();
  line('spo2', ySp, '#38bdf8');
  line('hr', yHr, '#34d399');
  ctx.restore();

  if (!state.vitals.length) {
    ctx.fillStyle = '#8b98a8'; ctx.textAlign = 'center';
    ctx.fillText('Sin datos en los últimos 10 minutos', padL + pw / 2, padT + ph / 2);
  }
}
window.addEventListener('resize', drawTrend);

transport = await pickTransport();
if (transport.kind === 'demo') {
  $('#demo-bar').hidden = false;
  renderDemoBar();
}
connect();
