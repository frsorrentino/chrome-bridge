/**
 * Ref scaduti (STALE_REF). Un ref punta a un selettore; se la pagina cambia
 * fra get_interactives e l'azione, lo stesso selettore può trovare un altro
 * elemento (una riga tolta da una lista e "li:nth-of-type(2)" è ora la
 * successiva) e il click va a segno sull'elemento sbagliato senza errori.
 * Prima di agire per ref il server rilegge l'elemento e lo confronta con quel
 * che il modello ha visto: tag ed etichetta. Se non torna, STALE_REF e niente
 * azione. Idea dall'analisi di chrome-devtools-axi (25/10/2026).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../../server/tools.js';
import { MessageType } from '../../server/protocol.js';

function setup(page) {
  const handlers = new Map();
  const sent = [];
  registerTools({ tool: (name, _d, _s, ...rest) => handlers.set(name, rest[rest.length - 1]) }, {
    isConnected: () => true, mode: 'primary', port: 8765,
    sendCommand: async (type, params) => {
      sent.push({ type, params });
      if (type === MessageType.GET_INTERACTIVES) return { count: page.snapshot.length, elements: structuredClone(page.snapshot) };
      if (type === MessageType.QUERY_DOM) {
        if (page.queryFails) throw new Error('Cannot access contents of url "chrome://x/"');
        const now = page.now[params.selector];
        return { count: now ? 1 : 0, elements: now ? [now] : [] };
      }
      if (type === MessageType.PAGE_FINGERPRINT) return { url: 'https://a.it/', title: 'A', nodes: 10, text: 10 };
      if (type === MessageType.CLICK) return { clicked: true };
      if (type === MessageType.TYPE_TEXT) return { typed: true };
      if (type === MessageType.HOVER) return { hovered: true };
      if (type === MessageType.FILL_FORM) return { filled: params.fields.length };
      if (type === MessageType.GET_TABS) return [];
      throw new Error(`unexpected ${type}`);
    },
  }, 'all');
  return { handlers, sent };
}

const SEL = '#lista > li:nth-of-type(2) > button';
const btn = (text) => ({ selector: SEL, tag: 'button', text, enabled: true, visible: true, rect: { x: 1, y: 1, width: 10, height: 10 } });
const dom = (tag, text, attributes = {}) => ({ tagName: tag, attributes, textContent: text });
const refOf = async (handlers) => {
  const res = await handlers.get('get_interactives')({ format: 'json' });
  const text = res.content.find((c) => c.type === 'text').text;
  return /"ref":"(n\d+)"/.exec(text)?.[1] ?? /\b(n\d+)\b/.exec(text)[1];
};
const clicks = (sent) => sent.filter((s) => s.type === MessageType.CLICK).length;

test('la riga è cambiata fra snapshot e click: STALE_REF e nessun click', async () => {
  const page = { snapshot: [btn('Elimina Alfa')], now: { [SEL]: dom('button', 'Elimina Beta') } };
  const { handlers, sent } = setup(page);
  const ref = await refOf(handlers);
  await assert.rejects(handlers.get('click')({ ref }), (e) => /STALE_REF/.test(e.message) && /Elimina Alfa/.test(e.message) && /get_interactives/.test(e.message));
  assert.equal(clicks(sent), 0);
});

test('l\'elemento non c\'è più: STALE_REF', async () => {
  const page = { snapshot: [btn('Salva')], now: {} };
  const { handlers, sent } = setup(page);
  const ref = await refOf(handlers);
  await assert.rejects(handlers.get('click')({ ref }), /STALE_REF/);
  assert.equal(clicks(sent), 0);
});

test('stesso elemento: il click parte', async () => {
  const page = { snapshot: [btn('Salva')], now: { [SEL]: dom('button', '  Salva  ') } };
  const { handlers, sent } = setup(page);
  const ref = await refOf(handlers);
  await handlers.get('click')({ ref });
  assert.equal(clicks(sent), 1);
});

test('etichetta da aria-label: non è scaduto', async () => {
  const page = { snapshot: [btn('Chiudi')], now: { [SEL]: dom('button', '', { 'aria-label': 'Chiudi' }) } };
  const { handlers, sent } = setup(page);
  await handlers.get('click')({ ref: await refOf(handlers) });
  assert.equal(clicks(sent), 1);
});

test('campo con <label for> esterno: conta il tag, non il testo', async () => {
  const input = { selector: '#email', tag: 'input', type: 'email', text: 'Indirizzo e-mail', enabled: true, visible: true };
  const page = { snapshot: [input], now: { '#email': dom('input', null, { id: 'email', type: 'email' }) } };
  const { handlers, sent } = setup(page);
  await handlers.get('type_text')({ ref: await refOf(handlers), text: 'a@b.it' });
  assert.equal(sent.filter((s) => s.type === MessageType.TYPE_TEXT).length, 1);
});

test('tag diverso allo stesso selettore: STALE_REF anche per un campo', async () => {
  const input = { selector: '#q', tag: 'input', type: 'text', text: 'Cerca', enabled: true, visible: true };
  const page = { snapshot: [input], now: { '#q': dom('div', 'Cerca') } };
  const { handlers } = setup(page);
  await assert.rejects(handlers.get('type_text')({ ref: await refOf(handlers), text: 'x' }), /STALE_REF/);
});

test('fill_form e hover controllano i ref', async () => {
  const page = { snapshot: [btn('Elimina Alfa')], now: { [SEL]: dom('button', 'Elimina Beta') } };
  const { handlers } = setup(page);
  const ref = await refOf(handlers);
  await assert.rejects(handlers.get('hover')({ ref }), /STALE_REF/);
  await assert.rejects(handlers.get('fill_form')({ fields: [{ ref: 'n999', value: 'x' }], submit_ref: ref }), /Unknown ref|STALE_REF/);
  await assert.rejects(handlers.get('fill_form')({ fields: [{ selector: '#x', value: 'x' }], submit_ref: ref }), /STALE_REF/);
});

test('rilettura impossibile (pagina non iniettabile, estensione vecchia): si agisce come prima', async () => {
  const page = { snapshot: [btn('Salva')], now: {}, queryFails: true };
  const { handlers, sent } = setup(page);
  await handlers.get('click')({ ref: await refOf(handlers) });
  assert.equal(clicks(sent), 1);
});

test('con il selettore niente controllo e nessuna query in più', async () => {
  const page = { snapshot: [], now: {} };
  const { handlers, sent } = setup(page);
  await handlers.get('click')({ selector: '#x' });
  assert.equal(sent.filter((s) => s.type === MessageType.QUERY_DOM).length, 0);
});
