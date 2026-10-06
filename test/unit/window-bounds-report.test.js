// create_tab/move_tab con new_window: i bounds reali della finestra tornano al
// chiamante, con una nota quando il window manager li ha cambiati (ChromeOS:
// 320 px chiesti, 501 ottenuti). La funzione vive nel service worker, che non
// si importa in Node: se ne estrae il sorgente e la si esegue con un chrome finto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../extension/service-worker.js', import.meta.url), 'utf8');
const body = src.match(/async function windowBoundsReport\([\s\S]*?\n}\n/)[0];

function load(win) {
  const chrome = { windows: { get: async () => win } };
  return new Function('chrome', `${body}; return windowBoundsReport;`)(chrome);
}

test('no bounds requested: nothing added, no windows.get', async () => {
  const report = load(null);
  assert.deepEqual(await report(7, { left: undefined, width: undefined }), {});
});

test('bounds honoured: window_bounds, no note', async () => {
  const report = load({ left: 0, top: 0, width: 800, height: 600 });
  const r = await report(7, { width: 800, height: 600 });
  assert.deepEqual(r, { window_bounds: { left: 0, top: 0, width: 800, height: 600 } });
});

test('width clamped by the window manager: bounds_note names it', async () => {
  const report = load({ left: 10, top: 0, width: 501, height: 700 });
  const r = await report(7, { width: 320, height: 700 });
  assert.equal(r.window_bounds.width, 501);
  assert.match(r.bounds_note, /width 320→501/);
  assert.doesNotMatch(r.bounds_note, /height \d/);
  assert.match(r.bounds_note, /emulate_media/);
});
