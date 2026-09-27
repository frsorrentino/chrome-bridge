/**
 * Un comando inviato prima che l'estensione si colleghi aspetta, entro un
 * limite, invece di fallire subito. Con --launch il primo navigate arrivava
 * prima che il Chrome appena avviato si collegasse: nel benchmark del
 * 27/09/2026 è successo in 4 run su 10, e due si sono arrese con la risposta
 * sbagliata.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { WSManager } from '../../server/ws-manager.js';

async function started(opts) {
  const m = new WSManager(0, { identTimeout: 500, ...opts });
  await m.start();
  return { m, port: m.wss.address().port };
}

// Finta estensione: si presenta con ext_init e risponde a ogni comando.
function fakeExtension(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'chrome-extension://abcdefghijklmnop' } });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'ext_init', version: 'test' })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id) ws.send(JSON.stringify({ id: msg.id, type: 'response', data: { ok: msg.type } }));
  });
  return ws;
}

test('un comando inviato prima della connessione parte quando l\'estensione arriva', async () => {
  const { m, port } = await started({ connectWait: 3000 });
  try {
    const t0 = Date.now();
    const pending = m.sendCommand('get_tabs');
    let ext;
    setTimeout(() => { ext = fakeExtension(port); }, 300);
    const data = await pending;
    assert.deepEqual(data, { ok: 'get_tabs' });
    assert.ok(Date.now() - t0 >= 250, 'ha aspettato la connessione');
    ext.close();
  } finally {
    await m.stop();
  }
});

test('senza estensione fallisce allo scadere, con l\'attesa scritta nel messaggio', async () => {
  const { m } = await started({ connectWait: 300 });
  try {
    const t0 = Date.now();
    await assert.rejects(m.sendCommand('get_tabs'), /Chrome extension not connected \(server primary on 127\.0\.0\.1:\d+, waited 0s\)/);
    assert.ok(Date.now() - t0 >= 280, 'non rifiuta subito');
  } finally {
    await m.stop();
  }
});

test('dopo un\'attesa scaduta i comandi successivi falliscono subito, senza sommare attese', async () => {
  const { m } = await started({ connectWait: 400 });
  try {
    await assert.rejects(m.sendCommand('get_tabs'), /not connected/);
    const t0 = Date.now();
    await assert.rejects(m.sendCommand('get_tabs'), /not connected/);
    assert.ok(Date.now() - t0 < 200, `il secondo invio ha aspettato ${Date.now() - t0} ms`);
  } finally {
    await m.stop();
  }
});

test('stop durante l\'attesa rifiuta senza aspettare il limite', async () => {
  const { m } = await started({ connectWait: 5000 });
  const t0 = Date.now();
  const pending = m.sendCommand('get_tabs');
  setTimeout(() => m.stop(), 100);
  await assert.rejects(pending, /not connected/);
  assert.ok(Date.now() - t0 < 1000);
});
