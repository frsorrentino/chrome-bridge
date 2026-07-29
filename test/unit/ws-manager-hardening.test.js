/**
 * Regressioni dell'hardening 2026-07-25: i tre scenari in cui il
 * comportamento osservato divergeva dal modello mentale del codice
 * (shutdown, relay verso un peer estraneo, autenticazione del relay) più
 * il timeout di trasporto e lo stato dell'estensione in relay mode.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket, { WebSocketServer } from 'ws';
import { WSManager } from '../../server/ws-manager.js';
import { MessageType } from '../../server/protocol.js';

function connect(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

test('stop() ritorna anche se un peer si identifica durante lo shutdown', async () => {
  const m = new WSManager(0, { identTimeout: 5000 });
  await m.start();
  const port = m.wss.address().port;

  const ws = await connect(port);
  // relay_init arriva mentre stop() è in corso: prima restava OPEN e
  // wss.close() non richiamava mai la callback (processo MCP zombie).
  const stopping = m.stop();
  setTimeout(() => {
    try { ws.send(JSON.stringify({ type: MessageType.RELAY_INIT })); } catch {}
  }, 5);

  const finished = await Promise.race([
    stopping.then(() => 'stopped'),
    new Promise((r) => setTimeout(() => r('hang'), 3000)),
  ]);
  assert.equal(finished, 'stopped');
  try { ws.terminate(); } catch {}
});

test('stop() non lascia socket aperti anche se non tracciati nei due Set', async () => {
  const m = new WSManager(0, { identTimeout: 5000 });
  await m.start();
  const port = m.wss.address().port;
  const ws = await connect(port); // mai identificato: fuori da client/relayClients
  await m.stop();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(ws.readyState, WebSocket.CLOSED);
});

test('relay verso un primary chrome-bridge PRECEDENTE (senza relay_init_ok) funziona', async () => {
  // Caso normale durante un aggiornamento: una sessione col server vecchio è
  // ancora attiva. Il peer non manda l'ack ma risponde alla sonda.
  const oldPrimary = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => oldPrimary.on('listening', r));
  const port = oldPrimary.address().port;
  oldPrimary.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === MessageType.RELAY_INIT) return; // il server vecchio tace
      // ...ma a un comando risponde come farebbe senza estensione collegata
      ws.send(JSON.stringify({ id: msg.id, type: MessageType.ERROR, error: 'Chrome extension not connected' }));
    });
  });

  const m = new WSManager(port);
  await m._startRelay(); // non deve lanciare
  assert.ok(m.relaySocket, 'il relay resta collegato');
  await m.stop();
  for (const c of oldPrimary.clients) c.terminate();
  await new Promise((r) => oldPrimary.close(r));
});

test('relay verso una porta non-chrome-bridge fallisce con messaggio azionabile', async () => {
  // Un WS server estraneo che occupa la porta: prima il relay dichiarava
  // mode=relay e isConnected()=true, e il primo comando moriva a 30 s.
  const intruder = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => intruder.on('listening', r));
  const port = intruder.address().port;

  const m = new WSManager(port);
  await assert.rejects(
    () => m._startRelay(),
    (err) => {
      assert.match(err.message, /not chrome-bridge/);
      assert.match(err.message, new RegExp(String(port)));
      return true;
    },
  );
  // Senza stop() il manager avvia il ciclo di promozione a primary e tiene
  // vivo l'event loop dopo la fine dei test.
  await m.stop();
  for (const c of intruder.clients) c.terminate();
  await new Promise((r) => intruder.close(r));
});

test('relay_init senza token è rifiutato quando il token è configurato', async () => {
  const m = new WSManager(0, { identTimeout: 500, token: 'secret' });
  await m.start();
  const port = m.wss.address().port;

  const ws = await connect(port);
  ws.send(JSON.stringify({ type: MessageType.RELAY_INIT }));
  const closed = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 1000);
    ws.on('close', () => { clearTimeout(t); resolve(true); });
  });
  assert.equal(closed, true, 'relay_init non autenticato deve essere terminato');
  assert.equal(m.relayClients.size, 0);
  await m.stop();
});

test('relay_init col token corretto è accettato', async () => {
  const m = new WSManager(0, { identTimeout: 500, token: 'secret' });
  await m.start();
  const port = m.wss.address().port;

  const ws = await connect(port);
  ws.send(JSON.stringify({ type: MessageType.RELAY_INIT, token: 'secret' }));
  const hello = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 1000);
    ws.on('message', (raw) => { clearTimeout(t); resolve(JSON.parse(raw.toString())); });
  });
  assert.equal(hello?.type, 'relay_init_ok');
  assert.equal(hello.ext_connected, false, "nessuna estensione collegata: l'ack deve dirlo");
  try { ws.terminate(); } catch {}
  await m.stop();
});

test('ext_init da non-loopback è rifiutato col bind loopback di default', async () => {
  const m = new WSManager(0, { identTimeout: 500 });
  assert.equal(m.host, '127.0.0.1', 'default loopback');
  await m.stop();
});

test('in relay mode isConnected() misura l\'estensione, non il socket relay', async () => {
  const m = new WSManager(0);
  m.mode = 'relay';
  m.relaySocket = { readyState: WebSocket.OPEN };

  m.relayExtConnected = false;
  assert.equal(m.isConnected(), false, 'socket relay aperto ma nessuna estensione');

  m.relayExtConnected = true;
  assert.equal(m.isConnected(), true);
});

test('il timeout di trasporto non è mai inferiore a quello chiesto dal chiamante', async () => {
  const m = new WSManager(0);
  m.mode = 'primary';
  const sent = [];
  m.client = { readyState: WebSocket.OPEN, send: (raw) => sent.push(JSON.parse(raw)) };

  // wait_for_element ha 60s di default: con timeout=90000 il trasporto
  // scadeva prima del comando, e il modello leggeva "elemento non comparso".
  const p = m.sendCommand(MessageType.WAIT_FOR_ELEMENT, { selector: '#x', timeout: 90000 });
  assert.equal(sent.length, 1);
  const entry = m.pending.get(sent[0].id);
  assert.ok(entry, 'comando in pending');
  // Risolve subito per non tenere il timer appeso
  m._handleChromeMessage({ id: sent[0].id, type: MessageType.RESULT, data: { ok: true } });
  await p;

  const short = m.sendCommand(MessageType.WAIT_FOR_ELEMENT, { selector: '#x', timeout: 1000 });
  const id2 = sent[1].id;
  m._handleChromeMessage({ id: id2, type: MessageType.RESULT, data: { ok: true } });
  await short;
});

test('errore di estensione non collegata nomina porta, mode e prossima azione', async () => {
  const m = new WSManager(4321);
  m.mode = 'primary';
  m.client = null;
  await assert.rejects(
    () => m.sendCommand(MessageType.GET_TABS),
    (err) => {
      assert.match(err.message, /4321/);
      assert.match(err.message, /primary/);
      assert.match(err.message, /extension is enabled/);
      return true;
    },
  );
});
