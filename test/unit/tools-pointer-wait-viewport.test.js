/**
 * Tre capacità che mancavano, aggiunte come parametri di tool esistenti e non
 * come tool nuovi: `Tool Count` è l'unico rilievo Glama
 * stabile su tre misurazioni, e queste non giustificano di peggiorarlo.
 *
 * - click: tasto destro (menu contestuali) e doppio click (selezione testo,
 *   handler dblclick). Nell'estensione `dblclick` e `contextmenu` non comparivano
 *   affatto.
 * - wait_for: attesa su testo. Si poteva già fare con condition=function, ma è la
 *   condizione più comune dopo l'elemento e passava da un'espressione JS scritta
 *   a mano.
 * - viewport_resize: leggere le dimensioni senza cambiarle. La descrizione del
 *   tool stessa rimandava a execute_js per misurare, che è una toppa.
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

test('click accetta tasto e numero di click', async () => {
  const { handlers, sent } = build({ clicked: true });
  const { schema, handler } = handlers.get('click');
  assert.ok(schema.button, 'nessun parametro button: il menu contestuale resta irraggiungibile');
  assert.ok(schema.count, 'nessun parametro count: dblclick non è emettibile');

  const clicks = () => sent.filter((m) => m.type === MessageType.CLICK);

  await handler({ selector: '#x', button: 'right' });
  assert.equal(clicks()[0].params.button, 'right');

  await handler({ selector: '#x', count: 2 });
  assert.equal(clicks()[1].params.count, 2);
});

test('click resta un click sinistro singolo se non si chiede altro', async () => {
  const { handlers, sent } = build({ clicked: true });
  await handlers.get('click').handler({ selector: '#x' });
  const click = sent.find((m) => m.type === MessageType.CLICK);
  assert.equal(click.params.button, 'left');
  assert.equal(click.params.count, 1);
});

test('wait_for attende la comparsa di un testo', async () => {
  const { handlers, sent } = build({ found: true });
  const { schema, handler } = handlers.get('wait_for');
  assert.ok(schema.condition._def?.entries?.text ?? String(schema.condition).includes('text'), 'condition non prevede "text"');

  await handler({ condition: 'text', text: 'Ordine confermato' });
  assert.equal(sent[0].type, MessageType.WAIT_FOR_TEXT);
  assert.equal(sent[0].params.text, 'Ordine confermato');
  assert.ok(sent[0].params.timeout > 0, 'il timeout deve avere un default esplicito');
});

test('viewport_resize legge le dimensioni senza toccarle', async () => {
  const { handlers, sent } = build({ actual: { viewportWidth: 1280, viewportHeight: 720, devicePixelRatio: 1 } });
  const { schema, handler } = handlers.get('viewport_resize');
  assert.ok(schema.action, 'nessun parametro action: non si può leggere senza scrivere');

  const res = await handler({ action: 'get' });
  const vp = sent.find((m) => m.type === MessageType.VIEWPORT_RESIZE);
  assert.equal(vp.params.read_only, true, 'action=get non deve ridimensionare nulla');
  assert.match(res.content.map((c) => c.text).join(' '), /1280/);
});

test('viewport_resize senza action continua a ridimensionare come prima', async () => {
  const { handlers, sent } = build({ actual: {} });
  await handlers.get('viewport_resize').handler({ preset: 'mobile' });
  const vp = sent.find((m) => m.type === MessageType.VIEWPORT_RESIZE);
  assert.equal(vp.params.preset, 'mobile');
  assert.notEqual(vp.params.read_only, true);
});
