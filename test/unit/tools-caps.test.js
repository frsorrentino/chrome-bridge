import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools, TOOL_CAPS } from '../../server/tools.js';

function setup(canned = {}, caps = 'all') {
  const handlers = new Map();
  const fakeServer = {
    tool(name, _desc, _schema, ...rest) {
      handlers.set(name, rest[rest.length - 1]);
    },
  };
  const fakeWs = {
    isConnected: () => true,
    mode: 'primary',
    port: 8765,
    sendCommand: async (type, params) => {
      if (typeof canned[type] === 'function') return canned[type](params);
      if (!(type in canned)) throw new Error(`No canned response for ${type}`);
      return canned[type];
    },
  };
  registerTools(fakeServer, fakeWs, caps);
  return handlers;
}

function textOf(result) {
  return result.content.find((c) => c.type === 'text')?.text;
}

// --- capability opt-in ---

test('caps=all registra tutti i 60 tool', () => {
  assert.equal(setup().size, 60);
});

test('caps=core registra solo il set core (43 tool)', () => {
  const handlers = setup({}, 'core');
  const optInCount = Object.values(TOOL_CAPS).flat().length;
  assert.equal(handlers.size, 60 - optInCount);
  assert.ok(handlers.has('click'));
  assert.ok(handlers.has('get_interactives'));
  assert.ok(!handlers.has('cookie_audit'));
  assert.ok(!handlers.has('inject_css'));
  assert.ok(!handlers.has('session_fixture'));
});

test('caps con gruppi aggiunge solo quei gruppi al core', () => {
  const handlers = setup({}, 'audits,visual');
  assert.ok(handlers.has('cookie_audit'));
  assert.ok(handlers.has('inject_css'));
  assert.ok(!handlers.has('track_events'));
  assert.ok(!handlers.has('session_fixture'));
});

test('tools/list attraverso il layer MCP reale: tutti gli schemi serializzano', async () => {
  // Guardia di regressione: gli schemi zod devono sopravvivere alla
  // conversione JSON-schema dell'SDK (es. z.record cambiato in zod 4)
  const server = new McpServer({ name: 't', version: '0' });
  registerTools(server, { isConnected: () => true, mode: 'p', port: 1, sendCommand: async () => ({}) }, 'all');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 60);
  await client.close();
});

test('caps=core con il server MCP reale: gruppi spenti, get_status({enable}) li accende con una sola notifica', async () => {
  const server = new McpServer({ name: 't', version: '0' }, { debouncedNotificationMethods: ['notifications/tools/list_changed'] });
  registerTools(server, { isConnected: () => true, mode: 'p', port: 1, sendCommand: async () => ({}) }, 'core');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' });
  let notices = 0;
  const { ToolListChangedNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notices++; });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const optIn = Object.values(TOOL_CAPS).flat().length;
  let { tools } = await client.listTools();
  assert.equal(tools.length, 60 - optIn);
  assert.ok(tools.some((t) => t.name === 'extract_table'), 'extract_table sta nel core');
  assert.ok(!tools.some((t) => t.name === 'cookie_audit'));
  const res = await client.callTool({ name: 'get_status', arguments: { enable: ['audits', 'visual'] } });
  const status = JSON.parse(res.content[0].text);
  assert.deepEqual(status.enabled.sort(), [...TOOL_CAPS.audits, ...TOOL_CAPS.visual].sort());
  assert.ok(status.caps_active.includes('audits') && status.caps_active.includes('visual'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(notices, 1, 'N tool accesi, una notifica');
  ({ tools } = await client.listTools());
  assert.equal(tools.length, 60 - optIn + TOOL_CAPS.audits.length + TOOL_CAPS.visual.length);
  const again = JSON.parse((await client.callTool({ name: 'get_status', arguments: { enable: ['audits'] } })).content[0].text);
  assert.deepEqual(again.enabled, [], 'riaccendere un gruppo attivo non fa nulla');
  await client.close();
});

test('ogni tool nei gruppi TOOL_CAPS esiste davvero', () => {
  const all = setup();
  for (const name of Object.values(TOOL_CAPS).flat()) {
    assert.ok(all.has(name), `gruppo cita tool inesistente: ${name}`);
  }
});

// --- ref da get_interactives ---

const ELEMENTS = {
  count: 2,
  elements: [
    { selector: '#btn-save', tag: 'button', text: 'Save', enabled: true, visible: true },
    { selector: '#field-email', tag: 'input', type: 'email', text: '', enabled: true, visible: true },
  ],
};

test('get_interactives assegna ref n1..nN in lines e json', async () => {
  const handlers = setup({ get_interactives: structuredClone(ELEMENTS) });
  const lines = textOf(await handlers.get('get_interactives')({}));
  assert.ok(lines.includes('n1\t#btn-save'));
  assert.ok(lines.includes('n2\t#field-email'));
});

test('click accetta ref e lo risolve nel selector memorizzato', async () => {
  let clicked = null;
  const handlers = setup({
    get_interactives: structuredClone(ELEMENTS),
    click: (params) => { clicked = params.selector; return { clicked: true }; },
    get_tabs: [],
  });
  await handlers.get('get_interactives')({});
  await handlers.get('click')({ ref: 'n1' });
  assert.equal(clicked, '#btn-save');
});

test('type_text accetta ref; ref ignoto o mancante erra chiaro', async () => {
  let typed = null;
  const handlers = setup({
    get_interactives: structuredClone(ELEMENTS),
    type_text: (params) => { typed = params.selector; return { ok: true }; },
  });
  await handlers.get('get_interactives')({});
  await handlers.get('type_text')({ ref: 'n2', text: 'x@y.it' });
  assert.equal(typed, '#field-email');
  await assert.rejects(handlers.get('type_text')({ ref: 'n99', text: 'x' }), /Unknown ref n99/);
  await assert.rejects(handlers.get('click')({}), /selector or ref/);
});

// --- delta post-azione ---

test('click riporta page_changed solo quando url/title cambiano', async () => {
  let navigated = false;
  const tab = () => [{ id: 1, active: true, url: navigated ? 'https://x.test/done' : 'https://x.test/form', title: 'X' }];
  const handlers = setup({
    click: () => { navigated = true; return { clicked: true }; },
    get_tabs: () => tab(),
  });
  const out = JSON.parse(textOf(await handlers.get('click')({ selector: '#go' })));
  assert.equal(out.page_changed.url, 'https://x.test/done');
  // Seconda volta: nessun cambiamento → niente page_changed
  const out2 = JSON.parse(textOf(await handlers.get('click')({ selector: '#go' })));
  assert.equal(out2.page_changed, undefined);
});

test('navigate allega preview interactives con ref e la mappa è usabile', async () => {
  let clicked = null;
  const handlers = setup({
    navigate: { url: 'https://x.test', title: 'X', tabId: 7 },
    get_interactives: structuredClone(ELEMENTS),
    click: (params) => { clicked = params.selector; return { clicked: true }; },
    get_tabs: [],
  });
  const text = textOf(await handlers.get('navigate')({ url: 'https://x.test' }));
  assert.ok(text.includes('n1\t#btn-save'), 'preview con ref presente');
  // La preview usa il tabId della navigazione come chiave refs
  await handlers.get('click')({ ref: 'n1', tab_id: 7 });
  assert.equal(clicked, '#btn-save');
});

test('navigate senza interactives disponibili non allega nulla', async () => {
  const handlers = setup({ navigate: { url: 'https://x.test', title: 'X', tabId: 7 } });
  const text = textOf(await handlers.get('navigate')({ url: 'https://x.test' }));
  assert.equal(text, JSON.stringify({ url: 'https://x.test', title: 'X', tabId: 7 }));
});

test('find_text allega interactives vicini al primo match, con ref usabili', async () => {
  let clicked = null;
  const handlers = setup({
    find_text: { count: 1, matches: [{ selector: 'td', context: 'Quantum Widget 1042', visible: true, position: { x: 20, y: 41680 } }] },
    get_interactives: { count: 3, elements: [
      { selector: 'nav > a', tag: 'a', text: 'Home', enabled: true, visible: true, rect: { x: 0, y: 10, width: 50, height: 20 } },
      { selector: '#row-1042 .details-btn', tag: 'button', text: 'Details', enabled: true, visible: true, rect: { x: 500, y: 41682, width: 64, height: 24 } },
      { selector: '#row-1050 .details-btn', tag: 'button', text: 'Details', enabled: true, visible: true, rect: { x: 500, y: 42000, width: 64, height: 24 } },
    ] },
    click: (params) => { clicked = params.selector; return { clicked: true }; },
    get_tabs: [],
  });
  const text = textOf(await handlers.get('find_text')({ text: 'Quantum Widget 1042' }));
  assert.ok(text.includes('near first match'));
  assert.ok(text.includes('n1\t#row-1042 .details-btn'), 'il più vicino è n1');
  assert.ok(!text.includes('nav > a'), 'lontani (dy>150) esclusi');
  await handlers.get('click')({ ref: 'n1' });
  assert.equal(clicked, '#row-1042 .details-btn');
});

test('find_text senza match visibili non allega nulla', async () => {
  const payload = { count: 0, matches: [] };
  const handlers = setup({ find_text: payload });
  const text = textOf(await handlers.get('find_text')({ text: 'nope' }));
  assert.equal(text, JSON.stringify(payload));
});

test('dopo navigate i comandi senza tab_id usano il tab di sessione', async () => {
  const seen = [];
  const handlers = setup({
    navigate: { url: 'https://x.test', title: 'X', tabId: 42 },
    find_text: (params) => { seen.push(params.tab_id); return { count: 0, matches: [] }; },
    tab_action: {},
  });
  await handlers.get('navigate')({ url: 'https://x.test' });
  await handlers.get('find_text')({ text: 'q' });
  assert.equal(seen[0], 42, 'tab di sessione iniettato');
  await handlers.get('find_text')({ text: 'q', tab_id: 7 });
  assert.equal(seen[1], 7, 'tab_id esplicito vince');
  // close del tab di sessione: si torna al tab attivo
  await handlers.get('tab_action')({ action: 'close' });
  await handlers.get('find_text')({ text: 'q' });
  assert.equal(seen[2], undefined);
});

test('click occluso non calcola delta né attese', async () => {
  const handlers = setup({
    click: { occluded: true },
    get_tabs: [{ id: 1, active: true, url: 'https://x.test', title: 'X' }],
  });
  const out = JSON.parse(textOf(await handlers.get('click')({ selector: '#covered' })));
  assert.equal(out.occluded, true);
  assert.equal(out.page_changed, undefined);
});

test('ref legati al frame: lo stesso selettore in due frame ha due ref, e il click va nel frame giusto', async () => {
  const sent = [];
  const handlers = setup({
    get_interactives: ({ frame_id }) => ({ elements: [{ selector: '#save', label: `save ${frame_id ?? 0}` }] }),
    page_fingerprint: {},
    click: (p) => { sent.push(p); return { clicked: true }; },
  });
  const main = textOf(await handlers.get('get_interactives')({}));
  const inner = textOf(await handlers.get('get_interactives')({ frame_id: 7 }));
  assert.match(main, /n1\t#save/);
  assert.match(inner, /n2\t#save/, 'ref distinto nel frame 7');
  await handlers.get('click')({ ref: 'n2' });
  assert.equal(sent.at(-1).frame_id, 7, 'il ref porta il suo frame');
  await handlers.get('click')({ ref: 'n1' });
  assert.equal(sent.at(-1).frame_id, undefined, 'frame principale');
  await assert.rejects(handlers.get('click')({ ref: 'n2', frame_id: 3 }), /belongs to frame 7/);
});

test('click che apre un menu allega i ref dei nuovi interactives; uno che non cambia nulla no', async () => {
  let open = 0;
  const handlers = setup({
    page_fingerprint: () => ({ url: 'https://x.test', title: 'X', nodes: 100 + open * 10, open }),
    click: () => { open = 1; return { clicked: true }; },
    get_interactives: { elements: [{ selector: '#menu-item-1', label: 'Profile' }] },
  });
  const text = textOf(await handlers.get('click')({ selector: '#menu' }));
  assert.match(text, /#menu-item-1/, 'ref del menu aperto nella stessa risposta');
  const text2 = textOf(await handlers.get('click')({ selector: '#noop' }));
  assert.doesNotMatch(text2, /#menu-item-1/, 'niente anteprima senza cambiamenti');
});

test('screenshot: stessi pixel della volta prima → nota invece dell\'immagine; if_changed:false la manda', async () => {
  let img = 'AAAA';
  const handlers = setup({ screenshot: () => ({ image: img, viewport: { width: 800, height: 600 } }) });
  const first = await handlers.get('screenshot')({});
  assert.ok(first.content.some((c) => c.type === 'image'));
  const second = await handlers.get('screenshot')({});
  assert.ok(!second.content.some((c) => c.type === 'image'));
  assert.match(textOf(second), /unchanged/);
  const forced = await handlers.get('screenshot')({ if_changed: false });
  assert.ok(forced.content.some((c) => c.type === 'image'));
  img = 'BBBB';
  const changed = await handlers.get('screenshot')({});
  assert.ok(changed.content.some((c) => c.type === 'image'));
});

test('read_console clear con output enorme: tutte le voci compaiono, accorciate, nessuna persa', async () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({ level: 'error', args: [`E${i} ` + 'x'.repeat(3000)], timestamp: i }));
  const handlers = setup({ read_console: { messages, count: 30 } });
  const text = textOf(await handlers.get('read_console')({ clear: true, limit: 50 }));
  for (let i = 0; i < 30; i++) assert.ok(text.includes(`E${i} `), `manca E${i}`);
  assert.doesNotMatch(text, /\[truncated/);
});
