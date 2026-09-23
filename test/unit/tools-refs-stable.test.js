/**
 * Ref stabili: get_interactives, la preview di navigate e i vicini di
 * find_text scrivono nello stesso registro. Prima ognuno ripartiva da n1 e
 * sostituiva la mappa: dopo un find_text, n3 indicava un altro elemento e il
 * click andava a segno sull'elemento sbagliato (osservato su Meta Ads
 * Manager, 23/09/2026: «Unknown ref n47»).
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
const el = (selector, y = 10) => ({ selector, tag: 'button', text: selector, enabled: true, visible: true, rect: { x: 10, y, width: 50, height: 20 } });

test('un find_text dopo get_interactives non cambia il significato dei ref già dati', async () => {
  let page = [el('#a'), el('#b'), el('#c'), el('#d')];
  const clicked = [];
  const { handlers } = setup({
    get_interactives: () => ({ count: page.length, elements: page }),
    find_text: { count: 1, matches: [{ selector: 'li', context: 'x', visible: true, position: { x: 10, y: 10 } }] },
    click: (p) => { clicked.push(p.selector); return { clicked: true }; },
    get_tabs: [],
  });
  const first = textOf(await handlers.get('get_interactives')({}));
  assert.ok(first.includes('n3\t#c'));

  // I vicini del find_text sono altri elementi: prendono numeri nuovi.
  page = [el('#menu-x'), el('#menu-y'), el('#c')];
  const found = textOf(await handlers.get('find_text')({ text: 'x' }));
  assert.ok(found.includes('n5\t#menu-x'), found);
  assert.ok(found.includes('n3\t#c'), 'un selettore già visto tiene il suo ref');

  await handlers.get('click')({ ref: 'n3' });
  await handlers.get('click')({ ref: 'n4' });
  await handlers.get('click')({ ref: 'n6' });
  assert.deepEqual(clicked, ['#c', '#d', '#menu-y']);
});

test('navigate svuota i ref ma non riusa i numeri: un ref vecchio dà errore parlante', async () => {
  const { handlers } = setup({
    get_interactives: { count: 2, elements: [el('#a'), el('#b')] },
    navigate: { url: 'https://x.test/2', title: 'X', tabId: 7 },
    click: { clicked: true },
    get_tabs: [],
  });
  await handlers.get('get_interactives')({ tab_id: 7 });
  const nav = textOf(await handlers.get('navigate')({ url: 'https://x.test/2', tab_id: 7 }));
  assert.ok(nav.includes('n3\t#a'), 'dopo la navigazione i numeri ripartono da dove erano');
  await assert.rejects(handlers.get('click')({ ref: 'n1', tab_id: 7 }), /Unknown ref n1 \(it was issued before the last navigate/);
  await assert.rejects(handlers.get('click')({ ref: 'n9', tab_id: 7 }), /refs issued so far go up to n4/);
});

test('senza nessuna scoperta il messaggio lo dice', async () => {
  const { handlers } = setup({});
  await assert.rejects(handlers.get('click')({ ref: 'n1' }), /Unknown ref n1 \(no refs issued for this tab yet\)/);
});
