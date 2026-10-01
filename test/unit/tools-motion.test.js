/**
 * animations e frames lato server: la finestra si apre prima dell'azione, che
 * passa dai comandi di sempre (click, hover, scroll, press_key), e si chiude
 * dopo. La logica nella pagina la provano motion.test.js e l'e2e in launch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../../server/tools.js';
import { MessageType } from '../../server/protocol.js';

const REC = {
  window_ms: 320, prefers_reduced_motion: false, support: { long_animation_frame: true },
  frames: { count: 18 }, long_frames: { count: 0, worst: [] }, layout_shifts: { cls: 0 }, interactions: { count: 0, inp_ms: null },
  animations: { summary: { count: 1 }, list: [{ kind: 'CSSTransition', selector: '.card', properties: ['transform'] }] },
};

function build(reply = () => REC) {
  const handlers = new Map(); const sent = [];
  registerTools({ tool: (n, _d, s, ...rest) => handlers.set(n, { handler: rest[rest.length - 1], schema: s }) },
    { isConnected: () => true, mode: 'primary', host: 'h', port: 1, sendCommand: async (t, p) => { sent.push({ type: t, params: p }); return reply(t, p); } }, 'all');
  return { handlers, sent };
}

test('animations con azione: start, hover, stop nell ordine, con ref alle animazioni', async () => {
  const { handlers, sent } = build();
  const res = await handlers.get('animations').handler({ duration_ms: 100, action: { type: 'hover', selector: '.card' }, limit: 50 });
  assert.deepEqual(sent.map((m) => m.params.op ?? m.type), ['start', MessageType.HOVER, 'stop']);
  assert.equal(sent[1].params.selector, '.card');
  const data = JSON.parse(res.content[0].text);
  assert.equal(data.animations[0].ref, 'n1');
  assert.equal(data.summary.count, 1);
});

test('animations senza durata né azione: una sola istantanea', async () => {
  const { handlers, sent } = build(() => ({ summary: { count: 0 }, animations: [] }));
  await handlers.get('animations').handler({ limit: 50 });
  assert.deepEqual(sent.map((m) => m.params.op), ['snapshot']);
});

test('frames: un azione fallita non perde la registrazione, la riporta', async () => {
  const { handlers, sent } = build((t) => {
    if (t === MessageType.CLICK) throw new Error('No element matches #nope');
    return structuredClone(REC);
  });
  const res = await handlers.get('frames').handler({ duration_ms: 100, action: { type: 'click', selector: '#nope' }, threshold_ms: 50, limit: 10 });
  assert.equal(sent.at(-1).params.op, 'stop');
  const data = JSON.parse(res.content[0].text);
  assert.match(data.action_error, /No element matches/);
  assert.deepEqual(data.animations, { count: 1 });
});

test('frames: la finestra è limitata a 30 s e l azione di scroll va a SCROLL_TO', async () => {
  const { handlers, sent } = build();
  const t0 = Date.now();
  await handlers.get('frames').handler({ duration_ms: 50, action: { type: 'scroll', y: 800 }, threshold_ms: 50, limit: 10 });
  assert.ok(Date.now() - t0 >= 300, 'dopo un azione la finestra resta aperta almeno 300 ms');
  const scroll = sent.find((m) => m.type === MessageType.SCROLL_TO);
  assert.equal(scroll.params.y, 800);
});
