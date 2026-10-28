/**
 * webmcp-hook.js in una pagina finta: document.modelContext con la forma
 * dell'explainer (registerTool, getTools, executeTool, toolchange) e form
 * dichiarativi <form toolname>.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../extension/webmcp-hook.js', import.meta.url), 'utf8');

// modelContext minimo: getTools restituisce RegisteredTool senza execute,
// executeTool chiama l'execute registrato (quello avvolto dal gancio).
function fakeModelContext() {
  const tools = new Map();
  const listeners = {};
  return {
    registerTool(t, opts) {
      tools.set(t.name, t);
      opts?.signal?.addEventListener('abort', () => tools.delete(t.name));
      listeners.toolchange?.forEach((fn) => fn());
    },
    async getTools() {
      return [...tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: JSON.stringify(t.inputSchema ?? {}), origin: 'https://shop.test' }));
    },
    async executeTool(rt, input, { signal } = {}) {
      return tools.get(rt.name).execute(input, { signal });
    },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
  };
}

function field(tag, attrs = {}, extra = {}) {
  return { tagName: tag, name: attrs.name, required: 'required' in attrs, disabled: false, value: attrs.value ?? '', getAttribute: (k) => attrs[k] ?? null, ...extra };
}
function form(attrs, elements) {
  return { elements, getAttribute: (k) => attrs[k] ?? null, hasAttribute: (k) => k in attrs };
}

function load({ mc = null, forms = [] } = {}) {
  const winListeners = {};
  const document = { modelContext: mc, querySelectorAll: (sel) => (sel === 'form[toolname]' ? forms : []) };
  const window = { addEventListener: (type, fn) => { winListeners[type] = fn; } };
  const ctx = vm.createContext({
    window, document, navigator: {}, location: { origin: 'https://shop.test' }, performance, AbortController, setTimeout, clearTimeout,
    Promise, JSON, String, Error, Object, Math, Date, Map, WeakSet, Boolean, FormData: class { constructor(f) { return f.__data ?? []; } },
  });
  vm.runInContext(SRC, ctx);
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const api = window.__cbWebmcp;
  return {
    document, winListeners,
    list: async () => plain(await api.list()),
    summary: async () => plain(await api.summary()),
    call: async (...a) => plain(await api.call(...a)),
    calls: (n) => plain(api.calls(n)),
  };
}

test('senza modelContext e senza form: nessuno strumento, WebMCP spento', async () => {
  const h = load();
  assert.deepEqual(await h.list(), { active: false, tools: [] });
});

test('strumenti imperativi: schema, origine, read_only dalle annotations, sensibile dal nome', async () => {
  const mc = fakeModelContext();
  const h = load({ mc });
  mc.registerTool({ name: 'search_products', description: 'Find products', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true }, execute: async ({ q }) => ({ hits: [q] }) });
  mc.registerTool({ name: 'checkout', description: 'Pay the cart', inputSchema: {}, execute: async () => ({ order: 7 }) });
  const { active, tools } = await h.list();
  assert.equal(active, true);
  const search = tools.find((t) => t.name === 'search_products');
  assert.deepEqual(search.input_schema, { type: 'object', properties: { q: { type: 'string' } } });
  assert.equal(search.kind, 'imperative');
  assert.equal(search.read_only, true);
  assert.equal(search.sensitive, undefined);
  assert.match(tools.find((t) => t.name === 'checkout').sensitive, /check.?out|pay/i);
});

test('webmcp_call: risultato, una sola voce nel registro con chiamante chrome-bridge', async () => {
  const mc = fakeModelContext();
  const h = load({ mc });
  mc.registerTool({ name: 'search_products', description: 'Find products', execute: async ({ q }) => ({ hits: [q] }) });
  const r = await h.call('search_products', { q: 'mug' });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.result, { hits: ['mug'] });
  const log = h.calls(10);
  assert.equal(log.length, 1);
  assert.equal(log[0].caller, 'chrome-bridge');
  assert.deepEqual(log[0].input, { q: 'mug' });
  assert.deepEqual(log[0].output, { hits: ['mug'] });
});

test('azione sensibile: senza confirm non parte, con confirm sì', async () => {
  const mc = fakeModelContext();
  const h = load({ mc });
  let runs = 0;
  mc.registerTool({ name: 'checkout', description: 'Complete the purchase', execute: async () => { runs += 1; return { order: 7 }; } });
  const asked = await h.call('checkout', {});
  assert.equal(asked.status, 'needs_confirmation');
  assert.equal(runs, 0);
  assert.equal(h.calls(10).length, 0);
  const done = await h.call('checkout', {}, { confirmed: true });
  assert.equal(done.status, 'ok');
  assert.equal(runs, 1);
});

test('chiamata di un altro agente: registrata con chiamante other, anche se fallisce', async () => {
  const mc = fakeModelContext();
  const h = load({ mc });
  mc.registerTool({ name: 'stock', description: 'Stock level', execute: async ({ sku }) => { if (!sku) throw new Error('sku required'); return { left: 3 }; } });
  const [rt] = await mc.getTools();
  await mc.executeTool(rt, { sku: 'A1' });
  await mc.executeTool(rt, {}).catch(() => {});
  const log = h.calls(10);
  assert.deepEqual(log.map((c) => [c.caller, c.status]), [['other', 'ok'], ['other', 'error']]);
  assert.equal(log[1].error, 'sku required');
  assert.equal((await h.list()).tools[0].calls, 2);
});

test('timeout: stato timeout e AbortSignal passato allo strumento', async () => {
  const mc = fakeModelContext();
  const h = load({ mc });
  let aborted = false;
  mc.registerTool({ name: 'slow', description: 'Slow lookup', execute: (_i, { signal }) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }) });
  const r = await h.call('slow', {}, { timeout: 50 });
  assert.equal(r.status, 'timeout');
  assert.equal(aborted, true);
});

test('nome sconosciuto: not_found con gli strumenti disponibili', async () => {
  const mc = fakeModelContext();
  const h = load({ mc });
  mc.registerTool({ name: 'a', description: '', execute: async () => 1 });
  const r = await h.call('b', {});
  assert.equal(r.status, 'not_found');
  assert.deepEqual(r.available, ['a']);
});

test('polyfill arrivato dopo il gancio: avvolto alla prima lettura, le chiamate successive finiscono nel registro', async () => {
  const h = load();
  const mc = fakeModelContext();
  h.document.modelContext = mc;
  assert.equal((await h.list()).active, true);
  mc.registerTool({ name: 'late', description: 'Registered later', execute: async () => 'x' });
  const [rt] = await mc.getTools();
  await mc.executeTool(rt, {});
  assert.equal(h.calls(5)[0].caller, 'other');
});

test('form dichiarativi: schema dai campi, GET non sensibile, POST sensibile; WebMCP spento li elenca comunque', async () => {
  const search = form({ toolname: 'search', tooldescription: 'Search the catalogue', method: 'get' }, [
    field('INPUT', { name: 'q', type: 'text', required: '', toolparamdescription: 'Words to look for' }),
    field('SELECT', { name: 'sort' }, { options: [{ value: 'price' }, { value: 'new' }] }),
    field('BUTTON', { type: 'submit' }),
  ]);
  const contact = form({ toolname: 'contact', tooldescription: 'Write to us', method: 'post', toolautosubmit: '' }, [
    field('INPUT', { name: 'email', type: 'email', required: '' }),
    field('INPUT', { name: 'qty', type: 'number' }),
    field('INPUT', { name: 'csrf', type: 'hidden' }),
  ]);
  const h = load({ forms: [search, contact] });
  const { active, tools } = await h.list();
  assert.equal(active, false);
  assert.deepEqual(tools[0], {
    name: 'search', description: 'Search the catalogue', kind: 'declarative', autosubmit: false,
    input_schema: { type: 'object', properties: { q: { type: 'string', description: 'Words to look for' }, sort: { type: 'string', enum: ['price', 'new'] } }, required: ['q'] },
  });
  assert.deepEqual(tools[1].input_schema.properties, { email: { type: 'string' }, qty: { type: 'number' } });
  assert.equal(tools[1].autosubmit, true);
  assert.match(tools[1].sensitive, /POST/);
  const r = await h.call('search', { q: 'x' });
  assert.equal(r.status, 'inactive');
});

test('invio dichiarativo di un agente: input e risposta di respondWith nel registro', async () => {
  const contact = form({ toolname: 'contact', method: 'post' }, []);
  const h = load({ forms: [contact] });
  let given;
  const ev = { target: contact, agentInvoked: true, respondWith: (p) => { given = p; } };
  contact.__data = [['email', 'a@b.test']];
  h.winListeners.submit(ev);
  ev.respondWith(Promise.resolve({ sent: true }));
  await given;
  await new Promise((r) => setTimeout(r, 0));
  const [c] = h.calls(5);
  assert.deepEqual([c.tool, c.kind, c.caller, c.status], ['contact', 'declarative', 'other', 'ok']);
  assert.deepEqual(c.input, { email: 'a@b.test' });
  assert.deepEqual(c.output, { sent: true });
});

test('summary: solo nomi, tipo e sensibilità', async () => {
  const mc = fakeModelContext();
  const h = load({ mc });
  mc.registerTool({ name: 'delete_account', description: 'Remove everything', execute: async () => 1 });
  assert.deepEqual(await h.summary(), { active: true, tools: [{ name: 'delete_account', kind: 'imperative', sensitive: true }] });
});

test('strumento registrato prima del gancio: la chiamata di un altro agente via executeTool è registrata una volta', async () => {
  const mc = fakeModelContext();
  mc.registerTool({ name: 'early', description: 'Known before the hook', execute: async () => 'e' });
  const h = load({ mc });
  const [rt] = await mc.getTools();
  assert.equal(await mc.executeTool(rt, { a: 1 }), 'e');
  assert.deepEqual(h.calls(5).map((c) => [c.tool, c.caller, c.status]), [['early', 'other', 'ok']]);
  const r = await h.call('early', {});
  assert.equal(r.status, 'ok');
  assert.deepEqual(h.calls(5).map((c) => c.caller), ['other', 'chrome-bridge']);
});
