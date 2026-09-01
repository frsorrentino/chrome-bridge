/**
 * Ritaglio per regione e ingrandimento su `element_screenshot`.
 *
 * La raccomandazione per la visione dei modelli recenti è un solo tool che
 * prende un bounding box e restituisce quella regione ritagliata e INGRANDITA:
 * sposta il calcolo sui token immagine invece che sullo sforzo di ragionamento.
 * `element_screenshot` era già il tool di ritaglio (per selettore): qui il box
 * si può indicare anche in coordinate CSS del viewport — lo stesso sistema dei
 * rect di get_interactives e query_dom — e si può chiedere un fattore di zoom.
 * Un concetto, un tool: niente `crop_screenshot` accanto.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../../server/tools.js';
import { MessageType } from '../../server/protocol.js';

function build(reply = {}) {
  const handlers = new Map();
  const sent = [];
  registerTools(
    { tool: (n, _d, s, ...rest) => handlers.set(n, { handler: rest[rest.length - 1], schema: s }) },
    {
      isConnected: () => true,
      mode: 'primary',
      host: '127.0.0.1',
      port: 8765,
      sendCommand: async (type, params) => { sent.push({ type, params }); return typeof reply === 'function' ? reply(type, params) : reply; },
    },
    'all',
  );
  return { handlers, sent };
}

const PNG = 'iVBORw0KGgo=';

test('element_screenshot accetta una regione in CSS px al posto del selettore', async () => {
  const { handlers, sent } = build({ image: PNG });
  const { schema, handler } = handlers.get('element_screenshot');
  assert.ok(schema.region, 'nessun parametro region: il ritaglio resta legato al DOM');
  assert.ok(schema.scale, 'nessun parametro scale: il ritaglio non si può ingrandire');
  assert.ok(!schema.selector.isOptional || schema.selector.isOptional(), 'selector deve essere opzionale quando c\'è region');

  const region = { x: 10, y: 20, width: 300, height: 40 };
  const res = await handler({ region, scale: 3 });
  const msg = sent.find((m) => m.type === MessageType.ELEMENT_SCREENSHOT);
  assert.deepEqual(msg.params.region, region);
  assert.equal(msg.params.scale, 3);
  assert.equal(msg.params.selector, undefined);
  assert.equal(res.content[0].type, 'image');
});

test('element_screenshot per selettore resta invariato e propaga scale', async () => {
  const { handlers, sent } = build({ image: PNG });
  await handlers.get('element_screenshot').handler({ selector: '#chart', scale: 2 });
  const msg = sent.find((m) => m.type === MessageType.ELEMENT_SCREENSHOT);
  assert.equal(msg.params.selector, '#chart');
  assert.equal(msg.params.scale, 2);
});

test('element_screenshot senza selettore né regione rifiuta prima di parlare con l\'estensione', async () => {
  const { handlers, sent } = build({ image: PNG });
  await assert.rejects(() => handlers.get('element_screenshot').handler({}), /selector|region/);
  assert.equal(sent.length, 0, 'un errore di input non deve costare un round-trip');
});

test('screenshot riporta la dimensione del viewport in CSS px, il sistema di riferimento di region', async () => {
  const { handlers } = build({ image: PNG, viewport: { width: 1280, height: 720 } });
  const res = await handlers.get('screenshot').handler({});
  const text = res.content.find((c) => c.type === 'text');
  assert.ok(text, 'senza la dimensione del viewport le coordinate di region sono un tiro a indovinare');
  assert.match(text.text, /1280.*720/);
  assert.ok(res.content.some((c) => c.type === 'image'));
});

test('screenshot con estensione vecchia (senza viewport) resta la sola immagine', async () => {
  const { handlers } = build({ image: PNG });
  const res = await handlers.get('screenshot').handler({});
  assert.deepEqual(res.content.map((c) => c.type), ['image']);
});
