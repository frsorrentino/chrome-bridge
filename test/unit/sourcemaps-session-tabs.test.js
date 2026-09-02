/**
 * - sourcemaps: bundle.js:1:11 → src/cart.ts:2:4 (addItem) via source map inline
 * - tab di sessione: create_tab le marca, get_tabs le mostra come mine,
 *   tab_action close_session chiude solo quelle
 * - read_console sourcemap=true passa dai fetch del browser (http_request)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResolver } from '../../server/sourcemaps.js';
import { registerTools } from '../../server/tools.js';
import { MessageType } from '../../server/protocol.js';

const MAP = { version: 3, sources: ['src/cart.ts'], names: ['init', 'addItem'], mappings: 'AAAAA,UACGC' };
const JS = `console.log(1);\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(MAP)).toString('base64')}`;

test('createResolver aggiunge sorgente:riga:colonna (funzione) ai frame risolvibili', async () => {
  const fetched = [];
  const r = createResolver(async (url) => { fetched.push(url); if (url.endsWith('bundle.js')) return JS; throw new Error('404'); });
  const out = await r.resolve('Uncaught TypeError: x at https://app.test/bundle.js:1:11 and https://app.test/other.js:3:4');
  assert.match(out, /https:\/\/app\.test\/bundle\.js:1:11 → src\/cart\.ts:2:4 \(addItem\)/);
  assert.match(out, /other\.js:3:4 and|other\.js:3:4$/);
  await r.resolve('again https://app.test/bundle.js:1:1');
  assert.equal(fetched.filter((u) => u.endsWith('bundle.js')).length, 1, 'la map è in cache');
  assert.equal(await r.resolve('nothing to resolve'), 'nothing to resolve');
});

test('createResolver segue una sourceMappingURL relativa', async () => {
  const r = createResolver(async (url) => (url.endsWith('.map') ? JSON.stringify(MAP) : 'x\n//# sourceMappingURL=app.js.map'));
  assert.match(await r.resolve('https://h/static/app.js:1:1'), /→ src\/cart\.ts:1:1 \(init\)/);
});

function build(reply) {
  const handlers = new Map(); const sent = [];
  const tools = registerTools({ tool: (n, _d, s, ...rest) => handlers.set(n, rest[rest.length - 1]) },
    { isConnected: () => true, mode: 'primary', host: 'h', port: 1, sendCommand: async (t, p) => { sent.push({ type: t, params: p }); return reply(t, p); } }, 'all');
  return { handlers, sent, tools };
}

test('le tab create dalla sessione sono marcate e close_session chiude solo quelle', async () => {
  const { handlers, sent } = build(async (t, p) => {
    if (t === MessageType.CREATE_TAB) return { id: 42, url: 'about:blank' };
    if (t === MessageType.GET_TABS) return [{ id: 42, url: 'about:blank' }, { id: 7, url: 'https://user.it' }];
    return { ok: true };
  });
  await handlers.get('create_tab')({ url: 'about:blank' });
  const tabs = JSON.parse((await handlers.get('get_tabs')({})).content[0].text);
  assert.deepEqual(tabs.map((t) => [t.id, t.mine ?? false]), [[42, true], [7, false]]);
  const status = JSON.parse((await handlers.get('get_status')({})).content[0].text);
  assert.deepEqual(status.owned_tabs, [42]);
  const res = await handlers.get('tab_action')({ action: 'close_session' });
  assert.deepEqual(JSON.parse(res.content[0].text), { closed: [42] });
  const closes = sent.filter((m) => m.type === MessageType.TAB_ACTION && m.params.action === 'close').map((m) => m.params.tab_id);
  assert.deepEqual(closes, [42], 'la tab dell\'utente (7) non va toccata');
});

test('closeEmptyOwnedTabs allo shutdown chiude solo le tab vuote create qui', async () => {
  const { handlers, sent, tools } = build(async (t) => {
    if (t === MessageType.CREATE_TAB) return { id: 1 };
    if (t === MessageType.GET_TABS) return [{ id: 1, url: 'https://kept.it/article' }, { id: 2, url: 'about:blank' }];
    return {};
  });
  await handlers.get('create_tab')({ url: 'x' });
  const closed = await tools.closeEmptyOwnedTabs();
  assert.deepEqual(closed, [], 'una tab nostra con contenuto resta aperta');
  assert.equal(sent.filter((m) => m.type === MessageType.TAB_ACTION).length, 0);
});

test('read_console sourcemap=true risolve i frame con i fetch del browser', async () => {
  const { handlers, sent } = build(async (t, p) => {
    if (t === MessageType.READ_CONSOLE) return { messages: [{ level: 'error', args: ['Uncaught boom at https://app.test/bundle.js:1:11'], timestamp: 5 }], count: 1 };
    if (t === MessageType.HTTP_REQUEST) return { status: 200, body: JS };
    return {};
  });
  const res = await handlers.get('read_console')({ level: 'error', limit: 50, format: 'lines', sourcemap: true });
  assert.match(res.content[0].text, /bundle\.js:1:11 → src\/cart\.ts:2:4 \(addItem\)/);
  assert.equal(sent.filter((m) => m.type === MessageType.HTTP_REQUEST).length, 1);
});
