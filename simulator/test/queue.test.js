import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StoreAndForwardQueue } from '../../shared/queue.js';
import { EcgSynth } from '../../shared/ecg.js';

test('asigna secuencias monotónicas y conserva el orden', () => {
  const q = new StoreAndForwardQueue({ bootId: 'b' });
  for (let i = 0; i < 5; i++) q.push({ i });
  assert.deepEqual(q.peekBatch(10).map((r) => r.seq), [0, 1, 2, 3, 4]);
});

test('solo borra lo confirmado', () => {
  const q = new StoreAndForwardQueue({ bootId: 'b' });
  for (let i = 0; i < 5; i++) q.push({ i });
  const batch = q.peekBatch(3);
  assert.equal(q.depth, 5); // peek no borra
  q.ack(batch);
  assert.equal(q.depth, 2);
  assert.equal(q.peekBatch(1)[0].seq, 3);
});

test('con memoria llena descarta lo más viejo y lo cuenta', () => {
  const q = new StoreAndForwardQueue({ bootId: 'b', capacity: 3 });
  for (let i = 0; i < 5; i++) q.push({ i });
  assert.equal(q.depth, 3);
  assert.equal(q.dropped, 2);
  assert.equal(q.peekBatch(1)[0].seq, 2);
});

test('ack de un lote ya descartado no borra datos nuevos', () => {
  const q = new StoreAndForwardQueue({ bootId: 'b', capacity: 2 });
  q.push({});
  const stale = q.peekBatch(1);
  q.push({}); q.push({}); // el registro 0 se descarta
  q.ack(stale);
  assert.equal(q.depth, 2);
});

test('el ECG sintético cae en el rango del ADC y tiene la FC pedida', () => {
  const synth = new EcgSynth({ fs: 125 });
  const s = synth.next(125 * 10, 75);
  assert.ok(s.every((v) => Number.isInteger(v) && v >= 0 && v <= 4095));
  // Contar picos R (cruces hacia arriba de un umbral alto).
  const thr = 2048 + 0.6 * 900;
  let beats = 0;
  for (let i = 1; i < s.length; i++) if (s[i - 1] < thr && s[i] >= thr) beats++;
  assert.ok(beats >= 11 && beats <= 14, `latidos en 10 s: ${beats}`);
});
