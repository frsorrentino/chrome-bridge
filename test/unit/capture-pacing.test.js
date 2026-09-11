/**
 * Chrome concede 2 captureVisibleTab al secondo per estensione; la terza entro
 * il secondo fallisce con MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND. Il bench di
 * latenza l'ha trovato: due screenshot ravvicinati, il secondo è un errore.
 * Il pacer aspetta il tempo che manca invece di far vedere la quota al modello.
 * Orologio e sleep iniettati: qui non passa tempo vero.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPacer } from '../../extension/lib/capture-pacing.js';

function clock(start = 1000) {
  let t = start;
  const slept = [];
  return {
    now: () => t,
    sleep: async (ms) => { slept.push(ms); t += ms; },
    advance: (ms) => { t += ms; },
    slept,
  };
}

test('la prima cattura non aspetta', async () => {
  const c = clock();
  const pace = createPacer({ minIntervalMs: 520, now: c.now, sleep: c.sleep });
  assert.equal(await pace(), 0);
  assert.deepEqual(c.slept, []);
});

test('una seconda cattura subito dopo aspetta il tempo che manca all\'intervallo', async () => {
  const c = clock();
  const pace = createPacer({ minIntervalMs: 520, now: c.now, sleep: c.sleep });
  await pace();
  c.advance(100);
  assert.equal(await pace(), 420);
  assert.deepEqual(c.slept, [420]);
});

test('passato l\'intervallo non aspetta', async () => {
  const c = clock();
  const pace = createPacer({ minIntervalMs: 520, now: c.now, sleep: c.sleep });
  await pace();
  c.advance(600);
  assert.equal(await pace(), 0);
});

test('tre catture di fila stanno a distanza di intervallo l\'una dall\'altra', async () => {
  const c = clock();
  const pace = createPacer({ minIntervalMs: 520, now: c.now, sleep: c.sleep });
  const times = [];
  for (let i = 0; i < 3; i++) { await pace(); times.push(c.now()); }
  assert.deepEqual(times, [1000, 1520, 2040]);
});

test('l\'intervallo di default tiene sotto le 2 catture al secondo', () => {
  const pace = createPacer({ now: () => 0, sleep: async () => {} });
  assert.ok(pace.minIntervalMs > 500, `minIntervalMs=${pace.minIntervalMs}`);
});
