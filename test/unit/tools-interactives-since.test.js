/**
 * get_interactives con since: dopo la prima lista, solo ciò che è cambiato.
 * Su una pagina da 80 elementi, ridare la lista intera dopo ogni azione
 * costava ~2-3k token per dire «è comparso un bottone». Il cursore identifica
 * la lista precedente; una navigazione (ref azzerati) o un cursore sconosciuto
 * tornano alla lista intera con una nota, mai a un diff sbagliato.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../../server/tools.js';
import { MessageType } from '../../server/protocol.js';

function build(pages) {
  const handlers = new Map();
  let i = 0;
  registerTools({ tool: (n, _d, s, ...rest) => handlers.set(n, { handler: rest[rest.length - 1], schema: s, desc: _d }) },
    { isConnected: () => true, mode: 'primary', host: 'h', port: 1, sendCommand: async (t) => {
      if (t === MessageType.GET_INTERACTIVES) { const els = pages[Math.min(i++, pages.length - 1)]; return { count: els.length, elements: els.map((e) => ({ ...e })) }; }
      throw new Error(`unexpected ${t}`);
    } }, 'all');
  return handlers;
}
const el = (selector, text, over = {}) => ({ selector, tag: 'button', text, enabled: true, visible: true, rect: { x: 0, y: 0, width: 10, height: 10 }, ...over });
const call = async (h, args = {}) => h.get('get_interactives').handler({ limit: 100, visible_only: true, format: 'lines', ...args }).then((r) => r.content[0].text);
const cursorOf = (text) => text.match(/cursor=(\S+)/)?.[1];

test('get_interactives: la lista intera termina con un cursore', async () => {
  const h = build([[el('#a', 'A'), el('#b', 'B')]]);
  const text = await call(h);
  assert.ok(cursorOf(text), text);
  assert.match(text, /n1\t#a/);
});

test('get_interactives since: solo aggiunti, cambiati e rimossi', async () => {
  const h = build([
    [el('#a', 'A'), el('#b', 'B'), el('#c', 'C')],
    [el('#a', 'A', { rect: { x: 5, y: 5, width: 10, height: 10 } }), el('#b', 'B', { enabled: false }), el('#d', 'D')],
  ]);
  const first = await call(h);
  const text = await call(h, { since: cursorOf(first) });
  assert.match(text, /^\+ n4\t#d/m, 'aggiunto con ref nuovo');
  assert.match(text, /^~ n2\t#b.*disabled/m, 'cambiato: ora disabled');
  assert.match(text, /removed: n3/);
  assert.doesNotMatch(text, /#a/, 'solo spostato: non è un cambiamento');
  assert.ok(cursorOf(text) && cursorOf(text) !== cursorOf(first), 'un cursore nuovo per il giro dopo');
});

test('get_interactives since: niente di cambiato → una riga', async () => {
  const h = build([[el('#a', 'A')], [el('#a', 'A')]]);
  const text = await call(h, { since: cursorOf(await call(h)) });
  assert.match(text, /no changes/);
  assert.doesNotMatch(text, /#a/);
});

test('get_interactives since: cursore sconosciuto → lista intera con nota', async () => {
  const h = build([[el('#a', 'A')]]);
  const text = await call(h, { since: 'i999' });
  assert.match(text, /n1\t#a/);
  assert.match(text, /full list/);
});

test('get_interactives since: scope diverso dal cursore → lista intera, non un diff fra liste diverse', async () => {
  const h = build([[el('#a', 'A')], [el('#b', 'B')]]);
  const c = cursorOf(await call(h));
  const text = await call(h, { since: c, scope: '#menu' });
  assert.match(text, /full list/);
  assert.doesNotMatch(text, /removed/);
});
