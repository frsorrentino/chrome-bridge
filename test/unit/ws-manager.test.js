import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { WSManager } from '../../server/ws-manager.js';

let manager;
let port;

// identTimeout di default (5 s): con 200 ms, a carico alto, il server chiudeva
// come muta una connessione il cui ext_init non era ancora stato letto.
before(async () => {
  manager = new WSManager(0);
  await manager.start();
  port = manager.wss.address().port;
});

after(async () => {
  await manager.stop();
});

function connect(headers = {}, p = port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${p}`, { headers });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Attese contate in giri di timer da 20 ms, non sull'orologio: a carico 30
// (16/10/2026) un secondo di tempo reale non bastava a un handshake locale e
// i test cadevano senza un difetto. Client e server stanno in questo processo:
// i giri che servono non crescono col carico. Ogni giro dura almeno 20 ms,
// quindi i timer del server (identTimeout, ping) scadono comunque dentro.
async function waitFor(fn, ticks = 50) {
  for (let i = 0; i < ticks; i++) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

function waitClose(ws, ticks = 50) {
  return waitFor(() => ws.readyState === WebSocket.CLOSED, ticks);
}

test('connessione muta viene terminata dopo identTimeout', async () => {
  const m = new WSManager(0, { identTimeout: 200 });
  await m.start();
  const ws = await connect({}, m.wss.address().port);
  const closed = await waitClose(ws);
  assert.equal(closed, true);
  assert.equal(m.isConnected(), false);
  await m.stop();
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
  await waitFor(() => !manager.isConnected());
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
  await waitFor(() => manager.relayClients.size === 0);
});

test('client che non risponde ai ping viene terminato', async () => {
  const m = new WSManager(0, { pingInterval: 100, pongGrace: 250 });
  await m.start();
  const ws = await connect({ origin: 'chrome-extension://abc' }, m.wss.address().port);
  // ext_init_ok, non isConnected(): lo stato connesso dura circa 450 ms
  // (ping ×2 + grace), e sotto carico cade fra due letture.
  let accepted = false;
  ws.on('message', (data) => { if (JSON.parse(data.toString()).type === 'ext_init_ok') accepted = true; });
  ws.send(JSON.stringify({ type: 'ext_init' }));
  assert.equal(await waitFor(() => accepted), true);
  // non rispondiamo mai ai ping JSON → entro pingInterval*2 + grace deve scollegare
  const closed = await waitClose(ws, 100);
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

test('dopo ext_init il server risponde ext_init_ok con version', async () => {
  const ws = await connect({ origin: 'chrome-extension://abcdefghijklmnop' });
  let msg = null;
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m.type === 'ext_init_ok') msg = m;
  });
  ws.send(JSON.stringify({ type: 'ext_init' }));
  assert.equal(await waitFor(() => msg !== null, 150), true, 'ext_init_ok non ricevuto');
  assert.match(msg.version, /^\d+\.\d+\.\d+$/);
  ws.close();
});
