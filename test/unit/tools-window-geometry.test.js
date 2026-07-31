/**
 * I tre pezzi che servono a posizionare le finestre su più monitor.
 *
 * Il progetto è: le sessioni del Terminale ChromeOS stanno in una finestra sola
 * (già consolidate), e vanno collocate su uno schermo scelto fra i tre.
 *
 * 1. `get_tabs` non riportava né geometria né stato delle finestre: senza quelli
 *    non si può decidere dove mettere niente, si può solo indovinare.
 * 2. `viewport_resize` sapeva cambiare le dimensioni ma non la posizione: su un
 *    solo schermo basta, su tre no — `left` è ciò che sceglie il monitor.
 * 3. `tile_windows` deduce l'area del monitor da una scheda scriptabile, e le
 *    finestre del Terminale hanno solo schede `chrome-untrusted://`. Con
 *    un'area esplicita il caso si sblocca invece di restare senza risposta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../../server/tools.js';
import { MessageType } from '../../server/protocol.js';

function build(reply) {
  const handlers = new Map();
  const sent = [];
  registerTools(
    { tool: (n, _d, s, ...rest) => handlers.set(n, { handler: rest[rest.length - 1], schema: s }) },
    {
      isConnected: () => true, mode: 'primary', host: '127.0.0.1', port: 8765,
      sendCommand: async (type, params) => { sent.push({ type, params }); return typeof reply === 'function' ? reply(type, params) : (reply ?? {}); },
    },
    'all',
  );
  return { handlers, sent };
}

test('get_tabs sa riportare anche le finestre, con geometria e stato', async () => {
  const { handlers, sent } = build({
    tabs: [{ id: 1, windowId: 10 }],
    windows: [{ id: 10, type: 'normal', state: 'normal', left: 1920, top: 0, width: 1280, height: 800, focused: true, tabs: 5 }],
  });
  const { schema, handler } = handlers.get('get_tabs');
  assert.ok(schema.include_windows, 'nessun parametro include_windows');

  const res = await handler({ include_windows: true });
  assert.equal(sent.find((m) => m.type === MessageType.GET_TABS).params.include_windows, true);
  const text = res.content.map((c) => c.text).join('');
  assert.match(text, /1920/, 'la posizione della finestra non arriva al chiamante');
  assert.match(text, /"state"/, 'lo stato della finestra non arriva al chiamante');
});

test('get_tabs senza il parametro resta la lista di schede di prima', async () => {
  const { handlers, sent } = build([{ id: 1, url: 'x', windowId: 10 }]);
  await handlers.get('get_tabs').handler({});
  assert.notEqual(sent.find((m) => m.type === MessageType.GET_TABS).params.include_windows, true);
});

test('viewport_resize accetta posizione e stato', async () => {
  const { handlers, sent } = build({ actual: {} });
  const { schema, handler } = handlers.get('viewport_resize');
  assert.ok(schema.left, 'nessun parametro left: senza, il monitor non si sceglie');
  assert.ok(schema.top, 'nessun parametro top');
  assert.ok(schema.state, 'nessun parametro state');

  await handler({ left: 1920, top: 0, width: 1280, height: 800 });
  const p = sent.find((m) => m.type === MessageType.VIEWPORT_RESIZE).params;
  assert.equal(p.left, 1920);
  assert.equal(p.top, 0);
});

test('viewport_resize inoltra lo stato richiesto', async () => {
  const { handlers, sent } = build({ actual: {} });
  await handlers.get('viewport_resize').handler({ state: 'maximized' });
  assert.equal(sent.find((m) => m.type === MessageType.VIEWPORT_RESIZE).params.state, 'maximized');
});

test('tile_windows accetta un\'area esplicita quando nessuna scheda è scriptabile', async () => {
  const { handlers, sent } = build({ monitor: {}, results: [] });
  const { schema, handler } = handlers.get('tile_windows');
  assert.ok(schema.area, 'nessun parametro area: le finestre del Terminale restano non affiancabili');

  const area = { left: 1920, top: 0, width: 1280, height: 800 };
  await handler({ area, layout: 'columns' });
  assert.deepEqual(sent.find((m) => m.type === MessageType.TILE_WINDOWS).params.area, area);
});
