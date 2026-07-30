/**
 * http_request esiste per una ragione sola: la fetch parte dal service worker
 * dell'estensione, quindi porta i cookie di sessione dell'utente. È la differenza
 * fra scaricare una fattura da un portale autenticato e ricevere la pagina di
 * login. Dal server Node la stessa richiesta non ha quei cookie.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools } from '../../server/tools.js';
import { MessageType } from '../../server/protocol.js';

function build(reply) {
  const handlers = new Map();
  const sent = [];
  const fakeServer = { tool: (n, _d, _s, ...rest) => handlers.set(n, rest[rest.length - 1]) };
  const fakeWs = {
    isConnected: () => true,
    mode: 'primary',
    host: '127.0.0.1',
    port: 8765,
    sendCommand: async (type, params) => {
      sent.push({ type, params });
      return typeof reply === 'function' ? reply(type, params) : reply;
    },
  };
  registerTools(fakeServer, fakeWs, 'all');
  return { handlers, sent };
}

const TEXT_REPLY = {
  status: 200,
  ok: true,
  url: 'https://example.test/api',
  content_type: 'application/json',
  headers: { 'content-type': 'application/json' },
  body: '{"invoice":42}',
  size: 14,
};

test('http_request è registrato nel set core, non dietro una capability', () => {
  const { handlers } = build(TEXT_REPLY);
  assert.ok(handlers.has('http_request'), 'http_request non registrato');

  const core = new Map();
  registerTools(
    { tool: (n, _d, _s, ...rest) => core.set(n, rest[rest.length - 1]) },
    { isConnected: () => true, mode: 'primary', host: '1', port: 1, sendCommand: async () => ({}) },
    'core',
  );
  assert.ok(core.has('http_request'), 'scaricare un file dietro login non è una funzione di nicchia');
});

test('inoltra url, metodo e header all\'estensione', async () => {
  const { handlers, sent } = build(TEXT_REPLY);
  await handlers.get('http_request')({
    url: 'https://example.test/api',
    method: 'POST',
    headers: { 'X-Test': '1' },
    body: '{"a":1}',
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, MessageType.HTTP_REQUEST);
  assert.equal(sent[0].params.url, 'https://example.test/api');
  assert.equal(sent[0].params.method, 'POST');
  assert.deepEqual(sent[0].params.headers, { 'X-Test': '1' });
  assert.equal(sent[0].params.body, '{"a":1}');
});

test('restituisce status e corpo testuale', async () => {
  const { handlers } = build(TEXT_REPLY);
  const res = await handlers.get('http_request')({ url: 'https://example.test/api' });
  const text = res.content.map((c) => c.text).join('\n');
  assert.match(text, /200/);
  assert.match(text, /invoice/);
});

test('con save_to scrive i byte su disco e non versa il binario nel contesto', async () => {
  const pdf = Buffer.from('%PDF-1.4 fake');
  const { handlers } = build({
    status: 200,
    ok: true,
    url: 'https://example.test/doc.pdf',
    content_type: 'application/pdf',
    headers: {},
    body_b64: pdf.toString('base64'),
    size: pdf.length,
  });

  const out = join(tmpdir(), `chrome-bridge-http-${process.pid}.pdf`);
  try {
    const res = await handlers.get('http_request')({ url: 'https://example.test/doc.pdf', save_to: out });
    const text = res.content.map((c) => c.text).join('\n');

    assert.equal((await readFile(out)).toString(), '%PDF-1.4 fake');
    assert.match(text, new RegExp(out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(text, /JVBERi/, 'il base64 non deve finire nella risposta al modello');
  } finally {
    await rm(out, { force: true });
  }
});

test('un corpo enorme viene troncato, non riversato per intero', async () => {
  const { handlers } = build({
    status: 200, ok: true, url: 'https://example.test/big', content_type: 'text/plain',
    headers: {}, body: 'x'.repeat(50000), size: 50000,
  });
  const res = await handlers.get('http_request')({ url: 'https://example.test/big', max_length: 500 });
  const text = res.content.map((c) => c.text).join('\n');
  assert.ok(text.length < 2000, `risposta di ${text.length} char: il cap max_length non è applicato`);
});

test('un errore HTTP è riportato, non silenziato', async () => {
  const { handlers } = build({
    status: 403, ok: false, url: 'https://example.test/api', content_type: 'text/html',
    headers: {}, body: 'Forbidden', size: 9,
  });
  const res = await handlers.get('http_request')({ url: 'https://example.test/api' });
  const text = res.content.map((c) => c.text).join('\n');
  assert.match(text, /403/);
});
