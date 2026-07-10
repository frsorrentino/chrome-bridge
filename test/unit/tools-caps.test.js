import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools, TOOL_CAPS } from '../../server/tools.js';

function setup(canned = {}, caps = 'all') {
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

test('caps=all registra tutti i 56 tool', () => {
  assert.equal(setup().size, 56);
});

test('caps=core registra solo il set core (28 tool)', () => {
  const handlers = setup({}, 'core');
  const optInCount = Object.values(TOOL_CAPS).flat().length;
  assert.equal(handlers.size, 56 - optInCount);
  assert.ok(handlers.has('click'));
  assert.ok(handlers.has('get_interactives'));
  assert.ok(!handlers.has('accessibility_audit'));
  assert.ok(!handlers.has('screenshot_diff'));
  assert.ok(!handlers.has('session_fixture'));
});

test('caps con gruppi aggiunge solo quei gruppi al core', () => {
  const handlers = setup({}, 'audits,visual');
  assert.ok(handlers.has('accessibility_audit'));
  assert.ok(handlers.has('screenshot_diff'));
  assert.ok(!handlers.has('network_rules'));
  assert.ok(!handlers.has('session_fixture'));
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

test('click occluso non calcola delta né attese', async () => {
  const handlers = setup({
    click: { occluded: true },
    get_tabs: [{ id: 1, active: true, url: 'https://x.test', title: 'X' }],
  });
  const out = JSON.parse(textOf(await handlers.get('click')({ selector: '#covered' })));
  assert.equal(out.occluded, true);
  assert.equal(out.page_changed, undefined);
});
