import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../../server/tools.js';

/** Fake ws che registra le chiamate (type, params) e risponde con canned. */
function setup(canned = {}) {
  const handlers = new Map();
  const calls = [];
  const fakeServer = { tool(name, _d, _s, handler) { handlers.set(name, handler); } };
  const fakeWs = {
    isConnected: () => true, mode: 'primary', port: 8765,
    sendCommand: async (type, params) => {
      calls.push({ type, params });
      return canned[type] ?? { ok: true };
    },
  };
  registerTools(fakeServer, fakeWs);
  return { handlers, calls };
}

test('tool separati wait/scroll non più registrati', () => {
  const { handlers } = setup();
  for (const name of ['wait_for_element', 'wait_for_function', 'wait_for_navigation', 'wait_for_network_idle', 'scroll_to', 'scroll_until']) {
    assert.ok(!handlers.has(name), `${name} ancora registrato`);
  }
  assert.ok(handlers.has('wait_for'));
  assert.ok(handlers.has('scroll'));
});

test('wait_for condition=element instrada su wait_for_element', async () => {
  const { handlers, calls } = setup();
  await handlers.get('wait_for')({ condition: 'element', selector: '.card', visible: true });
  assert.equal(calls[0].type, 'wait_for_element');
  assert.equal(calls[0].params.selector, '.card');
  assert.equal(calls[0].params.visible, true);
  assert.equal(calls[0].params.timeout, 10000);
  assert.equal(calls[0].params.interval, 200);
});

test('wait_for condition=function instrada su wait_for_function con polling_ms', async () => {
  const { handlers, calls } = setup();
  await handlers.get('wait_for')({ condition: 'function', expression: 'window.ready', interval: 50 });
  assert.equal(calls[0].type, 'wait_for_function');
  assert.equal(calls[0].params.expression, 'window.ready');
  assert.equal(calls[0].params.polling_ms, 50);
  assert.equal(calls[0].params.timeout, 10000);
});

test('wait_for condition=navigation: timeout default 15000, mode passato', async () => {
  const { handlers, calls } = setup();
  await handlers.get('wait_for')({ condition: 'navigation', mode: 'spa' });
  assert.equal(calls[0].type, 'wait_for_navigation');
  assert.equal(calls[0].params.mode, 'spa');
  assert.equal(calls[0].params.timeout, 15000);
});

test('wait_for condition=network_idle: idle_ms default 500', async () => {
  const { handlers, calls } = setup();
  await handlers.get('wait_for')({ condition: 'network_idle' });
  assert.equal(calls[0].type, 'wait_for_network_idle');
  assert.equal(calls[0].params.idle_ms, 500);
  assert.equal(calls[0].params.timeout, 15000);
});

test('scroll default action=to instrada su scroll_to', async () => {
  const { handlers, calls } = setup();
  await handlers.get('scroll')({ selector: '#footer', offset_y: -60 });
  assert.equal(calls[0].type, 'scroll_to');
  assert.equal(calls[0].params.selector, '#footer');
  assert.equal(calls[0].params.offset_y, -60);
});

test('scroll action=until instrada su scroll_until', async () => {
  const { handlers, calls } = setup();
  await handlers.get('scroll')({ action: 'until', until: 'element', selector: '.last-row', max_scrolls: 5 });
  assert.equal(calls[0].type, 'scroll_until');
  assert.equal(calls[0].params.until, 'element');
  assert.equal(calls[0].params.selector, '.last-row');
  assert.equal(calls[0].params.max_scrolls, 5);
});
