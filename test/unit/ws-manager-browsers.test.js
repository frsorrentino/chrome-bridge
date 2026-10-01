/**
 * Più browser sulla stessa porta: il 01/10/2026 un Chromium di prova ha preso
 * la connessione al Chrome dell'utente. Ora un browser diverso viene
 * rifiutato finché quello collegato risponde; lo stesso browser che si
 * riconnette sostituisce la sua vecchia connessione.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { WSManager, sameBrowser } from '../../server/ws-manager.js';

const ORIGIN = { origin: 'chrome-extension://abcdefghijklmnop' };

function extension(port, browser) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: ORIGIN });
    const got = [];
    ws.on('message', (raw) => got.push(JSON.parse(raw.toString())));
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'ext_init', version: '9.9.9', ...(browser && { browser }) }));
      setTimeout(() => resolve({ ws, got }), 150);
    });
    ws.on('error', reject);
  });
}
const closed = (ws) => new Promise((r) => (ws.readyState === WebSocket.CLOSED ? r(ws._closeCode) : ws.once('close', (code) => r(code))));

const A = { id: 'aaa', label: 'Google Chrome 154 on cros' };
const B = { id: 'bbb', label: 'Chromium 154 on linux (launch mode)' };

test('un secondo browser vivo viene rifiutato, quello collegato resta', async () => {
  const m = new WSManager(0, { identTimeout: 2000 });
  await m.start();
  const port = m.wss.address().port;
  const a = await extension(port, A);
  const b = await extension(port, B);
  assert.equal(await closed(b.ws), 4409);
  assert.ok(b.got.some((x) => x.type === 'ext_init_refused' && x.connected === A.label));
  assert.equal(a.ws.readyState, WebSocket.OPEN, 'il primo browser non perde la connessione');
  assert.equal(m.browser.label, A.label);
  assert.equal(m.refusedBrowsers[0].label, B.label);
  a.ws.terminate();
  await m.stop();
});

test('lo stesso browser che si riconnette sostituisce la vecchia connessione', async () => {
  const m = new WSManager(0, { identTimeout: 2000 });
  await m.start();
  const port = m.wss.address().port;
  const first = await extension(port, A);
  const again = await extension(port, A);
  await closed(first.ws);
  assert.equal(again.ws.readyState, WebSocket.OPEN);
  assert.equal(m.refusedBrowsers.length, 0);
  again.ws.terminate();
  await m.stop();
});

test('quando il primo browser si scollega, il secondo entra al tentativo successivo', async () => {
  const m = new WSManager(0, { identTimeout: 2000 });
  await m.start();
  const port = m.wss.address().port;
  const a = await extension(port, A);
  const b1 = await extension(port, B);
  await closed(b1.ws);
  a.ws.close();
  await closed(a.ws);
  await new Promise((r) => setTimeout(r, 50));
  const b2 = await extension(port, B);
  assert.equal(b2.ws.readyState, WebSocket.OPEN);
  assert.equal(m.browser.label, B.label);
  b2.ws.terminate();
  await m.stop();
});

test('sameBrowser: id uguali sì; due estensioni senza id come prima; id contro nessun id no', () => {
  assert.equal(sameBrowser(A, { ...A }), true);
  assert.equal(sameBrowser(A, B), false);
  assert.equal(sameBrowser(null, null), true);
  assert.equal(sameBrowser(A, null), false);
  assert.equal(sameBrowser(null, B), false);
});
