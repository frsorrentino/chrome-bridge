import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../extension/console-capture.js', import.meta.url), 'utf8');

// Pagina finta: window con i listener registrati e una console muta.
function loadCapture() {
  const listeners = {};
  const win = { addEventListener: (type, fn) => { listeners[type] = fn; } };
  const quiet = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  const ctx = vm.createContext({ window: win, console: quiet, Error, TypeError, JSON, String, Date });
  vm.runInContext(SRC, ctx);
  // Copia via JSON: gli array nati nel contesto vm hanno un altro prototipo.
  return { ctx, win, listeners, logs: () => JSON.parse(JSON.stringify(win.__chromeBridge_consoleLogs.map((l) => l.args))) };
}

const STACK = "TypeError: Cannot read properties of undefined (reading 'items')\n"
  + '    at renderCart (http://localhost:8791/dist/app.min.js:1:231)';

test('console.error(err) conserva lo stack invece di "{}"', () => {
  const { ctx, logs } = loadCapture();
  const err = new TypeError("Cannot read properties of undefined (reading 'items')");
  err.stack = STACK;
  ctx.console.error('Cart failed to load:', err);
  assert.deepEqual(logs()[0], ['Cart failed to load:', STACK]);
});

test('Error senza stack: nome e messaggio', () => {
  const { ctx, logs } = loadCapture();
  const err = new Error('boom');
  err.stack = '';
  ctx.console.warn(err);
  assert.deepEqual(logs()[0], ['Error: boom']);
});

test('oggetti normali restano JSON, primitivi restano stringhe', () => {
  const { ctx, logs } = loadCapture();
  ctx.console.log({ a: 1 }, 42, 'x');
  assert.deepEqual(logs()[0], ['{"a":1}', '42', 'x']);
});

test('errore non gestito: stack completo se c\'è error', () => {
  const { listeners, logs } = loadCapture();
  listeners.error({ message: 'Uncaught TypeError', filename: 'http://x/app.js', lineno: 1, colno: 9, error: { name: 'TypeError', message: 'x', stack: STACK } });
  assert.equal(logs()[0][0], `Uncaught ${STACK}`);
});

test('errore non gestito senza error: url:riga:colonna', () => {
  const { listeners, logs } = loadCapture();
  listeners.error({ message: 'Script error.', filename: 'http://x/app.min.js', lineno: 1, colno: 231, error: null });
  assert.equal(logs()[0][0], 'Uncaught Script error. at http://x/app.min.js:1:231');
});

test('rejection non gestita: stack del reason', () => {
  const { listeners, logs } = loadCapture();
  listeners.unhandledrejection({ reason: { name: 'TypeError', message: 'x', stack: STACK } });
  assert.equal(logs()[0][0], `Unhandled rejection: ${STACK}`);
  listeners.unhandledrejection({ reason: 'plain' });
  assert.equal(logs()[1][0], 'Unhandled rejection: plain');
});

test('risorsa che non si carica: dice quale, non «Uncaught  at ?:0:0»', () => {
  const { win, listeners, logs } = loadCapture();
  listeners.error({ target: { tagName: 'IMG', src: 'http://x/missing.png' }, message: '', filename: '', lineno: 0, colno: 0, error: null });
  assert.equal(logs()[0][0], 'Failed to load img http://x/missing.png');
  listeners.error({ target: win, message: 'boom', filename: 'http://x/a.js', lineno: 1, colno: 2, error: null });
  assert.equal(logs()[1][0], 'Uncaught boom at http://x/a.js:1:2');
});
