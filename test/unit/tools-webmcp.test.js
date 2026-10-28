/**
 * WebMCP lato server: la riga in navigate e get_interactives (solo se la
 * pagina dichiara strumenti), get_status, e webmcp_call che chiede conferma
 * e porta i ref della pagina nuova quando la chiamata naviga.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../../server/tools.js';

function setup(canned) {
  const handlers = new Map();
  const sent = [];
  registerTools({ tool: (name, _d, _s, ...rest) => handlers.set(name, rest[rest.length - 1]) }, {
    isConnected: () => true,
    mode: 'primary',
    port: 8765,
    sendCommand: async (type, params) => {
      sent.push({ type, params });
      const c = canned[type];
      if (typeof c === 'function') return c(params);
      if (c === undefined) throw new Error(`No canned response for ${type}`);
      return structuredClone(c);
    },
  }, 'all');
  return { handlers, sent };
}

const textOf = (r) => r.content.find((c) => c.type === 'text')?.text;
const el = (selector) => ({ selector, tag: 'button', text: selector, enabled: true, visible: true, rect: { x: 10, y: 10, width: 50, height: 20 } });
const PAGE = {
  navigate: { tabId: 7, url: 'https://shop.test/', title: 'Shop' },
  get_interactives: { count: 1, elements: [el('#buy')] },
  wait_for_network_idle: {},
  read_console: { messages: [] },
  monitor_network: { requests: [] },
};
const SHOP = { active: true, tools: [{ name: 'search_products', kind: 'imperative' }, { name: 'checkout', kind: 'imperative', sensitive: true }, { name: 'contact_us', kind: 'declarative', sensitive: true }] };

test('navigate: una riga webmcp con nomi, form e sensibili', async () => {
  const { handlers } = setup({ ...PAGE, webmcp: (p) => (p.action === 'summary' ? SHOP : null) });
  const text = textOf(await handlers.get('navigate')({ url: 'https://shop.test/' }));
  const line = text.split('\n').find((l) => l.startsWith('webmcp:'));
  assert.equal(line, 'webmcp: the page declares 3 tool(s): search_products, checkout (sensitive), contact_us (form, sensitive). '
    + 'webmcp_call runs one in a single step instead of clicks; webmcp_tools gives the schemas');
});

test('navigate: pagina senza strumenti o estensione vecchia, nessuna riga', async () => {
  for (const webmcp of [{ active: true, tools: [] }, () => { throw new Error('Unknown command type: webmcp'); }]) {
    const { handlers } = setup({ ...PAGE, webmcp });
    assert.doesNotMatch(textOf(await handlers.get('navigate')({ url: 'https://shop.test/' })), /webmcp/);
  }
});

test('WebMCP spento con form dichiarativi: la riga indica fill_form e come accenderlo', async () => {
  const { handlers } = setup({ ...PAGE, webmcp: { active: false, tools: [{ name: 'contact_us', kind: 'declarative', sensitive: true }] } });
  const text = textOf(await handlers.get('get_interactives')({}));
  assert.match(text, /webmcp: the page declares 1 form tool\(s\): contact_us \(form, sensitive\), but WebMCP is off in this Chrome; fill_form drives the form \(enable: chrome:\/\/flags\/#enable-webmcp-testing/);
});

test('get_interactives since: niente riga webmcp nel diff', async () => {
  const { handlers, sent } = setup({ ...PAGE, webmcp: SHOP });
  const first = textOf(await handlers.get('get_interactives')({}));
  const cursor = first.match(/cursor=(\S+)/)[1];
  const before = sent.filter((s) => s.type === 'webmcp').length;
  const diff = textOf(await handlers.get('get_interactives')({ since: cursor }));
  assert.doesNotMatch(diff, /webmcp/);
  assert.equal(sent.filter((s) => s.type === 'webmcp').length, before);
});

test('get_status: webmcp.active e, se spento, come accenderlo', async () => {
  const on = setup({ webmcp: SHOP });
  assert.deepEqual(JSON.parse(textOf(await on.handlers.get('get_status')({}))).webmcp, { active: true });
  const off = setup({ webmcp: { active: false, tools: [] } });
  const st = JSON.parse(textOf(await off.handlers.get('get_status')({}))).webmcp;
  assert.equal(st.active, false);
  assert.match(st.enable, /enable-webmcp-testing/);
});

test('webmcp_call: needs_confirmation dice di chiedere all\'utente; confirm arriva all\'estensione', async () => {
  const { handlers, sent } = setup({ webmcp: (p) => (p.confirm ? { status: 'ok', result: { order: 7 } } : { status: 'needs_confirmation', tool: 'checkout', reason: 'pay' }) });
  const asked = JSON.parse(textOf(await handlers.get('webmcp_call')({ name: 'checkout', input: {} })));
  assert.equal(asked.status, 'needs_confirmation');
  assert.match(asked.next, /ask the user/);
  const done = JSON.parse(textOf(await handlers.get('webmcp_call')({ name: 'checkout', input: {}, confirm: true })));
  assert.equal(done.status, 'ok');
  assert.deepEqual(sent.map((s) => s.params.confirm), [false, true]);
});

test('webmcp_call che naviga: navigated_to e i ref della pagina nuova', async () => {
  const { handlers } = setup({ ...PAGE, webmcp: { status: 'ok', result: { order: 7 }, navigated_to: 'https://shop.test/?ordered=7' } });
  const text = textOf(await handlers.get('webmcp_call')({ name: 'checkout', input: {}, confirm: true }));
  assert.match(text, /"navigated_to":"https:\/\/shop.test\/\?ordered=7"/);
  assert.match(text, /n1\t#buy/);
});

test('webmcp_tools: calls passa come limit; WebMCP spento aggiunge come accenderlo', async () => {
  const { handlers, sent } = setup({ webmcp: { active: false, tools: [] } });
  const out = JSON.parse(textOf(await handlers.get('webmcp_tools')({ calls: 5 })));
  assert.equal(sent[0].params.limit, 5);
  assert.match(out.enable, /enable-webmcp-testing/);
});
