/**
 * Misurare l'effetto, non l'azione. Un click che risponde "clicked: true" e
 * basta costringe il modello a uno screenshot per sapere se il menu si è
 * aperto; un type_text che non rilegge il campo dice "ok" anche quando un
 * campo controllato ha buttato via il valore. Qui il contratto lato server:
 * page_changed dall'impronta prima/dopo (con fallback a url/title quando
 * l'estensione è vecchia o la pagina non è iniettabile), value_after e
 * mismatch passati al modello con un avviso leggibile.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../../server/tools.js';
import { MessageType } from '../../server/protocol.js';

function build(reply) {
  const handlers = new Map(); const sent = [];
  registerTools({ tool: (n, _d, s, ...rest) => handlers.set(n, { handler: rest[rest.length - 1], schema: s, desc: _d }) },
    { isConnected: () => true, mode: 'primary', host: 'h', port: 1, sendCommand: async (t, p) => { sent.push({ type: t, params: p }); return reply(t, p, sent); } }, 'all');
  return { handlers, sent };
}
const textOf = (res) => res.content.map((c) => c.text ?? '').join('\n');
const fp = (over = {}) => ({ url: 'https://a.it/', title: 'A', nodes: 100, text: 2000, open: 0, expanded: 0, checked: 0, selected: 0, dialogs: 0, focus: 'body', ...over });

test('click: page_changed riporta il delta DOM fra le impronte prima e dopo', async () => {
  let calls = 0;
  const { handlers, sent } = build((t) => {
    if (t === MessageType.PAGE_FINGERPRINT) return (calls++ === 0) ? fp() : fp({ expanded: 1, nodes: 112, focus: 'ul#menu' });
    if (t === MessageType.CLICK) return { clicked: true, tagName: 'BUTTON' };
    throw new Error(`unexpected ${t}`);
  });
  const out = JSON.parse(textOf(await handlers.get('click').handler({ selector: '#dd', wait_after: 'none' })));
  assert.equal(out.clicked, true);
  assert.deepEqual(out.page_changed, { nodes: '+12', expanded: '+1', focus: 'ul#menu' });
  const order = sent.map((s) => s.type);
  assert.deepEqual(order, [MessageType.PAGE_FINGERPRINT, MessageType.CLICK, MessageType.PAGE_FINGERPRINT], 'impronta, click, impronta');
});

test('click: pagina stabile → nessun page_changed, zero byte in più', async () => {
  const { handlers } = build((t) => (t === MessageType.PAGE_FINGERPRINT ? fp() : { clicked: true }));
  const out = JSON.parse(textOf(await handlers.get('click').handler({ selector: '#x', wait_after: 'none' })));
  assert.ok(!('page_changed' in out));
});

test('click: estensione vecchia (page_fingerprint sconosciuto) → fallback a url/title da get_tabs, nessun errore', async () => {
  let tabs = 0;
  const { handlers } = build((t) => {
    if (t === MessageType.PAGE_FINGERPRINT) throw new Error('Unknown command: page_fingerprint');
    if (t === MessageType.GET_TABS) return [{ id: 7, active: true, url: tabs++ === 0 ? 'https://a.it/' : 'https://a.it/next', title: 'A' }];
    return { clicked: true };
  });
  const out = JSON.parse(textOf(await handlers.get('click').handler({ selector: 'a', wait_after: 'none' })));
  assert.deepEqual(out.page_changed, { url: 'https://a.it/next' });
});

test('click occluso: nessuna impronta dopo, come prima', async () => {
  const { handlers, sent } = build((t) => (t === MessageType.PAGE_FINGERPRINT ? fp() : { clicked: false, occluded: true, occluder: { selector: '#modal' } }));
  const out = JSON.parse(textOf(await handlers.get('click').handler({ selector: '#x' })));
  assert.equal(out.occluded, true);
  assert.equal(sent.filter((s) => s.type === MessageType.PAGE_FINGERPRINT).length, 1);
});

test('type_text: mismatch dell\'estensione diventa un avviso leggibile con il rimedio', async () => {
  const { handlers } = build(() => ({ typed: true, tagName: 'input', value_after: '', mismatch: true }));
  const text = textOf(await handlers.get('type_text').handler({ selector: '#email', text: 'a@b.it' }));
  assert.match(text, /"mismatch":\s*true/);
  assert.match(text, /mode=keys/, 'l\'avviso deve dire cosa provare');
  const ok = textOf(await build(() => ({ typed: true, tagName: 'input', value_after: 'a@b.it', mismatch: false })).handlers.get('type_text').handler({ selector: '#email', text: 'a@b.it' }));
  assert.doesNotMatch(ok, /mode=keys/);
});

test('fill_form: i campi con mismatch sono elencati in testa alla risposta', async () => {
  const { handlers } = build((t) => {
    if (t === MessageType.PAGE_FINGERPRINT) return fp();
    return { fields: [
      { selector: '#a', success: true, tagName: 'input', type: 'text', value_after: 'x', mismatch: false },
      { selector: '#b', success: true, tagName: 'input', type: 'email', value_after: '', mismatch: true },
    ] };
  });
  const text = textOf(await handlers.get('fill_form').handler({ fields: [{ selector: '#a', value: 'x' }, { selector: '#b', value: 'y' }] }));
  assert.match(text, /^mismatch: #b/m);
});

test('le descrizioni dicono che l\'effetto viene riportato', () => {
  const { handlers } = build(() => ({}));
  assert.match(handlers.get('click').desc, /page_changed/);
  assert.match(handlers.get('type_text').desc, /mismatch/);
  assert.match(handlers.get('fill_form').desc, /mismatch/);
});
