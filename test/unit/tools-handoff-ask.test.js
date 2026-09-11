/**
 * handoff, secondo giro: la persona davanti al browser può anche RISPONDERE
 * (ask: una casella di testo nel banner, "quale dei tre?") e indicare più di un
 * elemento (pick_max). Contratto lato server: i parametri passano
 * all'estensione, answer e picked_all tornano in righe leggibili, il formato
 * di prima resta identico per chi non usa le novità.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../../server/tools.js';
import { MessageType } from '../../server/protocol.js';

function build(reply) {
  const handlers = new Map(); const sent = [];
  registerTools({ tool: (n, d, s, ...rest) => handlers.set(n, { handler: rest[rest.length - 1], schema: s, desc: d }) },
    { isConnected: () => true, mode: 'primary', host: 'h', port: 1, sendCommand: async (t, p) => { sent.push({ type: t, params: p }); return reply(t, p); } }, 'all');
  return { handlers, sent };
}
const pick = (selector, text) => ({ selector, tag: 'button', text, rect: { x: 1, y: 2, width: 30, height: 10 } });

test('ask: passa all\'estensione e la risposta dell\'utente torna come riga answer', async () => {
  const { handlers, sent } = build(async () => ({ done: true, action: 'done', url: 'https://a.it/', answer: 'the blue one' }));
  const res = await handlers.get('handoff').handler({ message: 'Which one?', ask: true, timeout: 1000 });
  const m = sent.find((x) => x.type === MessageType.HANDOFF);
  assert.equal(m.params.ask, true);
  assert.match(res.content[0].text, /^handoff done url=https:\/\/a\.it\/\nanswer: the blue one$/m);
});

test('senza ask nessuna riga answer, anche se l\'estensione manda una stringa vuota', async () => {
  const { handlers } = build(async () => ({ done: true, action: 'done', url: 'https://a.it/', answer: '' }));
  const res = await handlers.get('handoff').handler({ message: 'Log in', timeout: 1000 });
  assert.doesNotMatch(res.content[0].text, /answer:/);
});

test('pick_max: passa all\'estensione e picked_all esce una riga per elemento, numerata', async () => {
  const { handlers, sent } = build(async () => ({ done: true, action: 'picked', url: 'https://a.it/', picked: pick('#a', 'A'), picked_all: [pick('#a', 'A'), pick('#b', 'B')] }));
  const res = await handlers.get('handoff').handler({ message: 'Pick the two buttons', pick_element: true, pick_max: 2, timeout: 1000 });
  const m = sent.find((x) => x.type === MessageType.HANDOFF);
  assert.equal(m.params.pick_max, 2);
  assert.match(res.content[0].text, /^picked 1\/2 #a\tbutton\tA\t@1,2 30x10$/m);
  assert.match(res.content[0].text, /^picked 2\/2 #b\tbutton\tB\t@1,2 30x10$/m);
  assert.equal((res.content[0].text.match(/^picked /gm) || []).length, 2, 'il primo elemento non va stampato due volte');
});

test('un solo elemento senza picked_all (estensione vecchia): la riga di sempre', async () => {
  const { handlers } = build(async () => ({ done: true, action: 'picked', url: 'https://a.it/', picked: pick('#save', 'Save') }));
  const res = await handlers.get('handoff').handler({ message: 'Which button?', pick_element: true, timeout: 1000 });
  assert.match(res.content[0].text, /^picked #save\tbutton\tSave\t@1,2 30x10$/m);
});

test('la descrizione dice che l\'utente può rispondere e indicare più elementi', () => {
  const { handlers } = build(async () => ({}));
  assert.match(handlers.get('handoff').desc, /ask/);
  assert.match(handlers.get('handoff').desc, /pick_max/);
  assert.ok('ask' in handlers.get('handoff').schema);
  assert.ok('pick_max' in handlers.get('handoff').schema);
});
