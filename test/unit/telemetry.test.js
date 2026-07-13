import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/telemetry.js';

const { pushError, buildDiagnostics } = globalThis.__cbTelemetry;

test('pushError accoda e limita a max (default 5)', () => {
  let buf = [];
  for (let i = 1; i <= 7; i++) buf = pushError(buf, { ts: i, tool: 't', message: `e${i}` });
  assert.equal(buf.length, 5);
  assert.equal(buf[0].message, 'e3'); // i più vecchi cadono
  assert.equal(buf[4].message, 'e7');
});

test('pushError non muta il buffer originale', () => {
  const orig = [{ ts: 1, tool: 'a', message: 'x' }];
  const next = pushError(orig, { ts: 2, tool: 'b', message: 'y' });
  assert.equal(orig.length, 1);
  assert.equal(next.length, 2);
});

test('buildDiagnostics produce JSON leggibile con tutti i campi', () => {
  const out = buildDiagnostics({
    extensionVersion: '1.7.0',
    serverVersion: '1.7.0',
    chromeVersion: '150.0.0.0',
    state: 'connected',
    port: 8765,
    userScriptsEnabled: false,
    instrument: true,
    toolCallCount: 42,
    lastTool: 'screenshot',
    recentErrors: [{ ts: 1, tool: 'click', message: 'boom' }],
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.extension, '1.7.0');
  assert.equal(parsed.server, '1.7.0');
  assert.equal(parsed.state, 'connected');
  assert.equal(parsed.userScripts, false);
  assert.equal(parsed.toolCalls, 42);
  assert.equal(parsed.recentErrors[0].message, 'boom');
});

test('buildDiagnostics con serverVersion null → "unknown"', () => {
  const parsed = JSON.parse(buildDiagnostics({
    extensionVersion: '1.7.0', serverVersion: null, chromeVersion: 'x',
    state: 'disconnected', port: 8765, userScriptsEnabled: true, instrument: false,
    toolCallCount: 0, lastTool: null, recentErrors: [],
  }));
  assert.equal(parsed.server, 'unknown');
});
