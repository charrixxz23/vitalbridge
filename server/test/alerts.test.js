import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertEngine } from '../../shared/alerts.js';

const feed = (engine, values, { start = 0, step = 1000, receivedAt } = {}) =>
  values.flatMap((v, i) => engine.evaluate({
    deviceId: 'd1', patientId: 'p1', ts: start + i * step, receivedAt: receivedAt ?? start + i * step, ...v,
  }));

test('una sola lectura fuera de rango no dispara (antirrebote)', () => {
  const e = new AlertEngine({ consecutive: 2 });
  assert.equal(feed(e, [{ spo2: 97 }, { spo2: 86 }, { spo2: 97 }]).length, 0);
});

test('dos lecturas seguidas disparan una sola alerta', () => {
  const e = new AlertEngine({ consecutive: 2 });
  const fired = feed(e, [{ spo2: 88 }, { spo2: 88 }, { spo2: 88 }, { spo2: 88 }]);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].rule, 'spo2_low');
  assert.equal(fired[0].severity, 'warning');
});

test('escala de advertencia a crítico', () => {
  const e = new AlertEngine({ consecutive: 2 });
  const fired = feed(e, [{ spo2: 88 }, { spo2: 88 }, { spo2: 83 }, { spo2: 82 }]);
  assert.deepEqual(fired.map((a) => a.severity), ['warning', 'critical']);
});

test('un pico crítico aislado dentro de una racha dispara con la severidad mínima sostenida', () => {
  const e = new AlertEngine({ consecutive: 2 });
  const fired = feed(e, [{ spo2: 88 }, { spo2: 80 }]);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].severity, 'warning');
});

test('se resuelve tras volver a la normalidad y puede volver a avisar', () => {
  const e = new AlertEngine({ consecutive: 2 });
  const fired = feed(e, [
    { hr: 130 }, { hr: 130 }, // dispara
    { hr: 80 }, { hr: 80 },   // se resuelve
    { hr: 131 }, { hr: 131 }, // vuelve a disparar
  ]);
  assert.equal(fired.length, 2);
  assert.ok(fired.every((a) => a.rule === 'hr_high'));
});

test('alerta retroactiva cuando la lectura llega tarde', () => {
  const e = new AlertEngine({ consecutive: 2, retroactiveAfterMs: 30_000 });
  const late = feed(e, [{ temp: 38.5 }, { temp: 38.6 }], { start: 0, receivedAt: 120_000 });
  assert.equal(late[0].retroactive, 1);

  const e2 = new AlertEngine({ consecutive: 2, retroactiveAfterMs: 30_000 });
  const live = feed(e2, [{ temp: 38.5 }, { temp: 38.6 }]);
  assert.equal(live[0].retroactive, 0);
});

test('valores nulos (sin dedo en el oxímetro) se ignoran', () => {
  const e = new AlertEngine({ consecutive: 2 });
  assert.equal(feed(e, [{ spo2: null, hr: null }, { spo2: null }]).length, 0);
});

test('el estado es independiente por equipo', () => {
  const e = new AlertEngine({ consecutive: 2 });
  e.evaluate({ deviceId: 'a', ts: 0, spo2: 85 });
  const fired = e.evaluate({ deviceId: 'b', ts: 1, spo2: 85 });
  assert.equal(fired.length, 0);
});
