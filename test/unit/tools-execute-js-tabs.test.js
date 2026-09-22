/**
 * Tre difetti visti sul campo il 2026-09-22 (ricerca su Pixabay):
 * - execute_js moriva a 30 s su uno script async lungo, senza modo di alzarlo;
 * - max_length tagliava la serializzazione a metà stringa: chi la parsava
 *   leggeva «Invalid control character at char 59999»;
 * - una scheda di sessione sparita dava solo «No tab with id», senza motivo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools, jsResultText } from '../../server/tools.js';

function build(reply) {
  const handlers = new Map();
  const calls = [];
  registerTools(
    { tool: (n, _d, s, ...rest) => handlers.set(n, { handler: rest[rest.length - 1], schema: s }) },
    {
      isConnected: () => true, mode: 'primary', host: '127.0.0.1', port: 8765,
      sendCommand: async (type, params) => { calls.push({ type, params }); return reply(type, params); },
    },
    'all',
  );
  return { handlers, calls };
}

const text = (res) => res.content.map((c) => c.text).join('');
const out = (n) => join(tmpdir(), `chrome-bridge-execjs-${process.pid}-${n}`);

test('execute_js passa timeout al comando, e senza timeout non lo inventa', async () => {
  const { handlers, calls } = build(() => ({ result: 1 }));
  await handlers.get('execute_js').handler({ code: '1', timeout: 120000 });
  await handlers.get('execute_js').handler({ code: '1' });
  assert.equal(calls[0].params.timeout, 120000);
  assert.equal('timeout' in calls[1].params, false);
});

test('execute_js con save_to scrive una stringa così com\'è e non la restituisce', async () => {
  const big = JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ i, url: `https://x.test/${i}` })));
  const { handlers } = build(() => ({ result: big }));
  const path = out('r.json');
  try {
    const res = text(await handlers.get('execute_js').handler({ code: 'x', save_to: path }));
    assert.equal(await readFile(path, 'utf8'), big);
    assert.ok(res.length < 300, `risposta di ${res.length} char`);
    assert.match(res, /r\.json/);
    assert.match(res, /"format":"text"/);
  } finally { await rm(path, { force: true }); }
});

test('execute_js con save_to scrive un oggetto come JSON', async () => {
  const { handlers } = build(() => ({ result: { a: [1, 2], b: 'ok' } }));
  const path = out('o.json');
  try {
    const res = text(await handlers.get('execute_js').handler({ code: 'x', save_to: path }));
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { a: [1, 2], b: 'ok' });
    assert.match(res, /"format":"json"/);
  } finally { await rm(path, { force: true }); }
});

test('una stringa tagliata resta JSON valido e dichiara il taglio', () => {
  // Righe con \n e virgolette: gli escape allungano la serializzazione.
  const value = 'riga "citata"\n'.repeat(10000);
  const res = jsResultText({ result: value }, 60000);
  assert.ok(res.length <= 60000, `${res.length} > 60000`);
  const parsed = JSON.parse(res);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.total_chars, value.length);
  assert.ok(value.startsWith(parsed.result));
  assert.ok(res.length > 59000, `il taglio butta via troppo: ${res.length}`);
  assert.match(parsed.hint, /save_to/);
});

test('un oggetto tagliato diventa un prefisso dichiarato, non JSON rotto', () => {
  const value = { rows: 'x'.repeat(5000), nested: { more: 'y'.repeat(5000) } };
  const parsed = JSON.parse(jsResultText({ result: value }, 2000));
  assert.equal(parsed.truncated, true);
  assert.ok(JSON.stringify(value).startsWith(parsed.result_json_prefix));
});

test('un array tagliato perde elementi interi', () => {
  const value = Array.from({ length: 1000 }, (_, i) => ({ i, t: 'testo '.repeat(5) }));
  const parsed = JSON.parse(jsResultText({ result: value }, 5000));
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.total, 1000);
  assert.deepEqual(parsed.result[0], value[0]);
});

test('sotto il tetto la risposta è quella di sempre', () => {
  assert.equal(jsResultText({ result: 'breve' }, 20000), '{"result":"breve"}');
});

function tabsBridge(state) {
  return (type, params) => {
    if (type === 'create_tab') return { id: state.nextId++ };
    if (type === 'get_tabs') {
      const list = state.tabs.map((id) => ({ id, url: 'https://x.test', title: 't', active: false, windowId: 1 }));
      if (!params.ended || state.oldExtension) return list;
      const open = new Set(state.tabs);
      return { tabs: list, ended: Object.fromEntries(params.ended.filter((id) => !open.has(id)).map((id) => [id, state.endings[id] ?? { reason: 'unknown' }])) };
    }
    return {};
  };
}

test('get_tabs senza schede di sessione risponde con l\'array di sempre', async () => {
  const { handlers, calls } = build(tabsBridge({ tabs: [1, 2], endings: {}, nextId: 10 }));
  const res = JSON.parse(text(await handlers.get('get_tabs').handler({})));
  assert.ok(Array.isArray(res));
  assert.equal('ended' in calls[0].params, false);
});

test('get_tabs segnala una volta la scheda di sessione chiusa, con il motivo', async () => {
  const state = { tabs: [1], endings: {}, nextId: 483581306 };
  const { handlers } = build(tabsBridge(state));
  await handlers.get('create_tab').handler({ active: false });
  state.tabs.push(483581306);

  let res = JSON.parse(text(await handlers.get('get_tabs').handler({})));
  assert.ok(Array.isArray(res), 'scheda ancora aperta: niente closed_session_tabs');
  assert.equal(res.find((t) => t.id === 483581306).mine, true);

  state.tabs = [1];
  state.endings[483581306] = { reason: 'closed', at: '2026-09-22T10:00:00.000Z' };
  res = JSON.parse(text(await handlers.get('get_tabs').handler({})));
  assert.deepEqual(res.closed_session_tabs, [{ id: 483581306, reason: 'closed', at: '2026-09-22T10:00:00.000Z' }]);

  res = JSON.parse(text(await handlers.get('get_tabs').handler({})));
  assert.ok(Array.isArray(res), 'la stessa chiusura segnalata due volte');
});

test('get_tabs: una scheda sostituita da Chrome resta della sessione con il nuovo id', async () => {
  const state = { tabs: [1], endings: {}, nextId: 50 };
  const { handlers, calls } = build(tabsBridge(state));
  await handlers.get('create_tab').handler({});
  state.tabs = [1, 51];
  state.endings[50] = { reason: 'replaced', replaced_by: 51 };

  const res = JSON.parse(text(await handlers.get('get_tabs').handler({})));
  assert.equal(res.closed_session_tabs[0].replaced_by, 51);
  assert.equal(res.tabs.find((t) => t.id === 51).mine, true);

  // Il tab implicito segue la sostituzione.
  await handlers.get('execute_js').handler({ code: '1' });
  assert.equal(calls.at(-1).params.tab_id, 51);
});

test('get_tabs con un\'estensione precedente: motivo unknown, niente errore', async () => {
  const state = { tabs: [1], endings: {}, nextId: 7, oldExtension: true };
  const { handlers } = build(tabsBridge(state));
  await handlers.get('create_tab').handler({});
  const res = JSON.parse(text(await handlers.get('get_tabs').handler({})));
  assert.deepEqual(res.closed_session_tabs, [{ id: 7, reason: 'unknown' }]);
});

test('tab_action close toglie la scheda dalle schede di sessione', async () => {
  const state = { tabs: [1], endings: {}, nextId: 9 };
  const { handlers } = build((type, params) => (type === 'tab_action' ? { action: 'close', closed: params.tab_id } : tabsBridge(state)(type, params)));
  await handlers.get('create_tab').handler({});
  await handlers.get('tab_action').handler({ action: 'close', tab_id: 9 });
  const res = JSON.parse(text(await handlers.get('get_tabs').handler({})));
  assert.ok(Array.isArray(res), 'una chiusura chiesta dal modello riappare come sparizione');
});
