import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { WSManager } from '../../server/ws-manager.js';

let manager;
let port;

before(async () => {
  manager = new WSManager(0, { identTimeout: 200 });
  await manager.start();
  port = manager.wss.address().port;
});

after(async () => {
  await manager.stop();
});

function connect(headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitClose(ws, ms = 1000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    ws.on('close', () => { clearTimeout(t); resolve(true); });
  });
}

async function waitFor(fn, ms = 1000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

test('connessione muta viene terminata dopo identTimeout', async () => {
  const ws = await connect();
  const closed = await waitClose(ws);
  assert.equal(closed, true);
  assert.equal(manager.isConnected(), false);
});

test('primo messaggio sconosciuto → terminate', async () => {
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'pong' }));
  const closed = await waitClose(ws);
  assert.equal(closed, true);
});

test('ext_init con Origin non-extension → terminate', async () => {
  const ws = await connect({ origin: 'http://evil.example' });
  ws.send(JSON.stringify({ type: 'ext_init' }));
  const closed = await waitClose(ws);
  assert.equal(closed, true);
  assert.equal(manager.isConnected(), false);
});

test('ext_init senza Origin → terminate', async () => {
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'ext_init' }));
  const closed = await waitClose(ws);
  assert.equal(closed, true);
  assert.equal(manager.isConnected(), false);
});

test('ext_init con Origin chrome-extension:// → accettato', async () => {
  const ws = await connect({ origin: 'chrome-extension://abcdefghijklmnop' });
  ws.send(JSON.stringify({ type: 'ext_init' }));
  assert.equal(await waitFor(() => manager.isConnected()), true);
  ws.close();
  await new Promise((r) => setTimeout(r, 100));
});

test('ext_init con token sbagliato quando token impostato → terminate', async () => {
  const m2 = new WSManager(0, { identTimeout: 200, token: 'secret' });
  await m2.start();
  const p2 = m2.wss.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${p2}`, { headers: { origin: 'chrome-extension://abc' } });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'ext_init', token: 'wrong' }));
  const closed = await waitClose(ws);
  assert.equal(closed, true);
  assert.equal(m2.isConnected(), false);
  await m2.stop();
});

test('relay_init da loopback → accettato come relay', async () => {
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'relay_init' }));
  assert.equal(await waitFor(() => manager.relayClients.size === 1), true);
  ws.close();
  await new Promise((r) => setTimeout(r, 100));
});

test('client che non risponde ai ping viene terminato', async () => {
  const m = new WSManager(0, { identTimeout: 200, pingInterval: 100, pongGrace: 250 });
  await m.start();
  const p = m.wss.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${p}`, { headers: { origin: 'chrome-extension://abc' } });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'ext_init' }));
  assert.equal(await waitFor(() => m.isConnected()), true);
  // non rispondiamo mai ai ping JSON → entro pingInterval*2 + grace deve scollegare
  const closed = await waitClose(ws, 2000);
  assert.equal(closed, true);
  await m.stop();
});

test('stop() impedisce promozione successiva', async () => {
  const m = new WSManager(0, { identTimeout: 200 });
  await m.start();
  const oldPort = m.wss.address().port;
  await m.stop();
  assert.equal(m.stopped, true);
  await m._promoteToPrimary(); // deve essere no-op
  // nessun nuovo server in ascolto sulla vecchia porta
  const probe = new WebSocket(`ws://127.0.0.1:${oldPort}`);
  const failed = await new Promise((resolve) => {
    probe.on('error', () => resolve(true));
    probe.on('open', () => { probe.close(); resolve(false); });
  });
  assert.equal(failed, true);
});
