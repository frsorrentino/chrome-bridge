/**
 * handoff anche nel terminale: con un client che dichiara l'elicitation, la
 * richiesta form corre accanto al banner e vince la prima risposta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../../server/tools.js';
import { MessageType } from '../../server/protocol.js';

// Estensione finta: HANDOFF aspetta un clic sul banner (bannerAfterMs) o un
// HANDOFF_END dal server, come cmdHandoff/cmdHandoffEnd.
function fakeExtension({ bannerAfterMs = null } = {}) {
  const sent = [];
  let pending = null;
  return {
    sent,
    isConnected: () => true, mode: 'primary', host: 'h', port: 1,
    sendCommand: async (type, params) => {
      sent.push({ type, params });
      if (type === MessageType.HANDOFF) {
        return new Promise((resolve) => {
          pending = resolve;
          if (bannerAfterMs != null) setTimeout(() => resolve({ done: true, action: 'done', url: 'https://a.it/', answer: 'from banner' }), bannerAfterMs);
        });
      }
      if (type === MessageType.HANDOFF_END) {
        pending?.({ done: params.action === 'done', action: params.action, url: 'https://a.it/', via: 'terminal', ...(params.answer != null && { answer: params.answer }) });
        return { ended: true };
      }
      return {};
    },
  };
}

async function setup(ext, onElicit) {
  const server = new McpServer({ name: 't', version: '0' });
  registerTools(server, ext, 'all');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' }, { capabilities: onElicit ? { elicitation: { form: {} } } : {} });
  if (onElicit) client.setRequestHandler(ElicitRequestSchema, onElicit);
  await Promise.all([server.connect(st), client.connect(ct)]);
  // Messaggi dal server al client, per vedere notifications/cancelled: il
  // Client dell'SDK non chiude il gestore di una elicitation annullata.
  client.wire = [];
  const deliver = ct.onmessage;
  ct.onmessage = (msg, extra) => { client.wire.push(msg); return deliver(msg, extra); };
  return client;
}
const text = (r) => r.content[0].text;

test('risposta nel terminale: chiude il banner e riporta la risposta', async () => {
  const ext = fakeExtension();
  let asked;
  const client = await setup(ext, async (req) => { asked = req.params; return { action: 'accept', content: { answer: 'the second one' } }; });
  const r = await client.callTool({ name: 'handoff', arguments: { message: 'Which plan?', ask: true } });
  assert.equal(asked.mode, 'form');
  assert.match(asked.message, /^Which plan\?/);
  assert.deepEqual(asked.requestedSchema.required, ['answer']);
  assert.ok(ext.sent.some((m) => m.type === MessageType.HANDOFF_END && m.params.action === 'done'));
  assert.match(text(r), /^handoff done url=https:\/\/a\.it\/ via=terminal\nanswer: the second one/);
  await client.close();
});

test('rifiuto nel terminale: handoff cancel', async () => {
  const ext = fakeExtension();
  const client = await setup(ext, async () => ({ action: 'decline' }));
  const r = await client.callTool({ name: 'handoff', arguments: { message: 'Log in' } });
  assert.match(text(r), /^handoff cancel .*via=terminal/);
  await client.close();
});

test('clic sul banner prima: la richiesta nel terminale viene annullata', async () => {
  const ext = fakeExtension({ bannerAfterMs: 50 });
  let reached = false;
  const client = await setup(ext, () => new Promise(() => { reached = true; }));
  const r = await client.callTool({ name: 'handoff', arguments: { message: 'Solve the CAPTCHA' } });
  assert.match(text(r), /^handoff done url=https:\/\/a\.it\/$/);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(reached, true, 'la richiesta è arrivata al client');
  const elicit = client.wire.find((m) => m.method === 'elicitation/create');
  assert.ok(client.wire.some((m) => m.method === 'notifications/cancelled' && m.params.requestId === elicit.id), 'il server annulla la richiesta nel terminale');
  assert.ok(!ext.sent.some((m) => m.type === MessageType.HANDOFF_END));
  await client.close();
});

test('estensione 1.27 senza handoff_end: vale la risposta del terminale, la chiamata non resta appesa', async () => {
  const ext = fakeExtension();
  const send = ext.sendCommand;
  ext.sendCommand = async (type, params) => {
    if (type === MessageType.HANDOFF_END) { ext.sent.push({ type, params }); throw new Error('Unknown command type: handoff_end'); }
    return send(type, params);
  };
  const client = await setup(ext, async () => ({ action: 'accept', content: { answer: 'yes' } }));
  const r = await client.callTool({ name: 'handoff', arguments: { message: 'Ok?', ask: true } });
  assert.match(text(r), /^handoff done via=terminal\nanswer: yes\n.*banner is still open/);
  await client.close();
});

test('client senza elicitation, pick_element o in_terminal false: solo il banner', async () => {
  for (const [cap, args] of [[false, {}], [true, { pick_element: true }], [true, { in_terminal: false }]]) {
    const ext = fakeExtension({ bannerAfterMs: 10 });
    let asked = false;
    const client = await setup(ext, cap ? async () => { asked = true; return { action: 'accept', content: {} }; } : null);
    const r = await client.callTool({ name: 'handoff', arguments: { message: 'x', ...args } });
    assert.match(text(r), /^handoff done/);
    assert.equal(asked, false);
    await client.close();
  }
});
