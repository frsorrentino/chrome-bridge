import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../../server/tools.js';

function setup(canned = {}) {
  const handlers = new Map();
  const fakeServer = { tool(name, _d, _s, handler) { handlers.set(name, handler); } };
  const fakeWs = {
    isConnected: () => true, mode: 'primary', port: 8765,
    sendCommand: async (type) => {
      if (!(type in canned)) throw new Error(`No canned response for ${type}`);
      return canned[type];
    },
  };
  registerTools(fakeServer, fakeWs);
  return handlers;
}
const textOf = (r) => r.content.find((c) => c.type === 'text')?.text;

const consoleData = {
  count: 3,
  messages: [
    { level: 'log', args: ['avvio app'], timestamp: 1700000000000 },
    { level: 'warn', args: ['cache miss', '{"k":1}'], timestamp: 1700000000120 },
    { level: 'error', args: ['boom'], timestamp: 1700000000500 },
  ],
};

test('read_console: default formato lines con header e delta ms', async () => {
  const handlers = setup({ read_console: consoleData });
  const text = textOf(await handlers.get('read_console')({}));
  const lines = text.split('\n');
  assert.match(lines[0], /total=3 shown=3/);
  assert.equal(lines[1], 'log\t+0ms\tavvio app');
  assert.equal(lines[2], 'warn\t+120ms\tcache miss {"k":1}');
  assert.equal(lines[3], 'error\t+500ms\tboom');
});

test('read_console: format=json resta disponibile', async () => {
  const handlers = setup({ read_console: consoleData });
  const out = JSON.parse(textOf(await handlers.get('read_console')({ format: 'json' })));
  assert.equal(out.total, 3);
  assert.equal(out.messages.length, 3);
});

const netData = {
  count: 2,
  requests: [
    { type: 'fetch', method: 'GET', url: 'https://x.test/ok', startTime: 1, status: 200, duration: 45, error: null },
    { type: 'xhr', method: 'POST', url: 'https://x.test/fail', startTime: 2, status: null, duration: 3000, error: 'timeout' },
  ],
};

test('monitor_network: default formato lines', async () => {
  const handlers = setup({ monitor_network: netData });
  const text = textOf(await handlers.get('monitor_network')({}));
  const lines = text.split('\n');
  assert.match(lines[0], /total=2 shown=2/);
  assert.equal(lines[1], '200\t45ms\tGET\thttps://x.test/ok');
  assert.equal(lines[2], 'ERR(timeout)\t3000ms\tPOST\thttps://x.test/fail');
});

test('monitor_network: format=json e format=har restano disponibili', async () => {
  const handlers = setup({ monitor_network: netData });
  const json = JSON.parse(textOf(await handlers.get('monitor_network')({ format: 'json' })));
  assert.equal(json.total, 2);
  const har = JSON.parse(textOf(await handlers.get('monitor_network')({ format: 'har' })));
  assert.equal(har.log.entries.length, 2);
});

const interactivesData = {
  count: 2,
  elements: [
    { selector: '#save', tag: 'button', type: 'submit', text: 'Salva', enabled: true, visible: true, occluded: false, rect: { x: 10, y: 20, width: 100, height: 40 } },
    { selector: 'nav > a:nth-of-type(2)', tag: 'a', type: null, text: 'Home', enabled: true, visible: true, occluded: true, rect: { x: 0, y: 0, width: 80, height: 20 } },
  ],
};

test('get_interactives: default formato lines, flag solo se anomali', async () => {
  const handlers = setup({ get_interactives: interactivesData });
  const text = textOf(await handlers.get('get_interactives')({}));
  const lines = text.split('\n');
  assert.match(lines[0], /count=2/);
  assert.equal(lines[1], '#save\tbutton:submit\tSalva\t@10,20 100x40');
  assert.equal(lines[2], 'nav > a:nth-of-type(2)\ta\tHome\toccluded\t@0,0 80x20');
});

test('get_interactives: format=json resta disponibile', async () => {
  const handlers = setup({ get_interactives: interactivesData });
  const out = JSON.parse(textOf(await handlers.get('get_interactives')({ format: 'json' })));
  assert.equal(out.count, 2);
});

test('check_links: default formato lines', async () => {
  // Scheme non supportato: checkLinksBatch marca broken senza fare rete
  const handlers = setup({ collect_links: { links: [{ url: 'ftp://a.test/x', text: 'file' }], totalAnchors: 5 } });
  const text = textOf(await handlers.get('check_links')({}));
  const lines = text.split('\n');
  assert.match(lines[0], /total=1 checked=1 broken=1/);
  assert.equal(lines[1], '0\tftp://a.test/x\tUnsupported scheme');
});
