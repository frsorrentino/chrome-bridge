import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../../server/tools.js';

/**
 * Registra i tool su un server fake e restituisce la mappa name → handler.
 * Il wsManager fake risponde con payload canned per MessageType.
 */
function setup(canned = {}) {
  const handlers = new Map();
  const fakeServer = {
    tool(name, _desc, _schema, handler) {
      handlers.set(name, handler);
    },
  };
  const fakeWs = {
    isConnected: () => true,
    mode: 'primary',
    port: 8765,
    sendCommand: async (type, _params) => {
      if (!(type in canned)) throw new Error(`No canned response for ${type}`);
      return canned[type];
    },
  };
  registerTools(fakeServer, fakeWs);
  return handlers;
}

function textOf(result) {
  const block = result.content.find((c) => c.type === 'text');
  return block?.text;
}

test('output JSON compatto, senza pretty-print', async () => {
  const tabs = [{ id: 1, url: 'https://x.test', title: 'X', active: true, windowId: 9 }];
  const handlers = setup({ get_tabs: tabs });
  const text = textOf(await handlers.get('get_tabs')({}));
  assert.equal(text, JSON.stringify(tabs));
  assert.ok(!text.includes('\n'));
});

test('read_console: default limit 50, tail, riporta total', async () => {
  const messages = Array.from({ length: 200 }, (_, i) => ({
    level: 'log', args: [`msg ${i}`], timestamp: 1700000000000 + i,
  }));
  const handlers = setup({ read_console: { count: 200, messages } });
  const out = JSON.parse(textOf(await handlers.get('read_console')({ format: 'json' })));
  assert.equal(out.total, 200);
  assert.equal(out.messages.length, 50);
  // tail: gli ultimi 50, non i primi
  assert.equal(out.messages[0].args[0], 'msg 150');
  assert.equal(out.messages[49].args[0], 'msg 199');
});

test('read_console: limit esplicito', async () => {
  const messages = Array.from({ length: 200 }, (_, i) => ({
    level: 'log', args: [`msg ${i}`], timestamp: 1700000000000 + i,
  }));
  const handlers = setup({ read_console: { count: 200, messages } });
  const out = JSON.parse(textOf(await handlers.get('read_console')({ limit: 10, format: 'json' })));
  assert.equal(out.messages.length, 10);
  assert.equal(out.messages[9].args[0], 'msg 199');
});

test('monitor_network: default limit 100, tail, riporta total', async () => {
  const requests = Array.from({ length: 300 }, (_, i) => ({
    type: 'fetch', method: 'GET', url: `https://x.test/${i}`,
    startTime: 1700000000000 + i, status: 200, duration: 10, error: null,
  }));
  const handlers = setup({ monitor_network: { count: 300, requests } });
  const out = JSON.parse(textOf(await handlers.get('monitor_network')({ format: 'json' })));
  assert.equal(out.total, 300);
  assert.equal(out.requests.length, 100);
  assert.equal(out.requests[0].url, 'https://x.test/200');
});

test('monitor_network: limit applicato anche al formato HAR', async () => {
  const requests = Array.from({ length: 300 }, (_, i) => ({
    type: 'fetch', method: 'GET', url: `https://x.test/${i}`,
    startTime: 1700000000000 + i, status: 200, duration: 10, error: null,
  }));
  const handlers = setup({ monitor_network: { count: 300, requests } });
  const out = JSON.parse(textOf(await handlers.get('monitor_network')({ format: 'har', limit: 5 })));
  assert.equal(out.log.entries.length, 5);
});

test('truncation globale a 20000 char sui tool senza max_length', async () => {
  const elements = Array.from({ length: 500 }, (_, i) => ({
    tagName: 'div', id: `el-${i}`, textContent: 'x'.repeat(100),
  }));
  const handlers = setup({ query_dom: { count: 500, elements } });
  const text = textOf(await handlers.get('query_dom')({ selector: 'div' }));
  assert.ok(text.length < 20200, `output ${text.length} char, atteso troncato ~20000`);
  assert.ok(text.includes('[truncated'), 'manca marker di troncamento');
});

test('execute_js: max_length esplicito rispettato', async () => {
  const handlers = setup({ execute_js: { result: 'y'.repeat(5000) } });
  const text = textOf(await handlers.get('execute_js')({ code: '1', max_length: 100 }));
  assert.ok(text.length < 300, `output ${text.length} char, atteso troncato a ~100`);
  assert.ok(text.includes('[truncated'));
});
