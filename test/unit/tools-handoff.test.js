/**
 * handoff: l'umano davanti al browser fa quello che il modello non può (2FA,
 * CAPTCHA, "quale elemento?") e il tool aspetta il clic sul banner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../../server/tools.js';
import { MessageType, getTimeout } from '../../server/protocol.js';

function build(reply) {
  const handlers = new Map(); const sent = [];
  registerTools({ tool: (n, _d, s, ...rest) => handlers.set(n, { handler: rest[rest.length - 1], schema: s }) },
    { isConnected: () => true, mode: 'primary', host: 'h', port: 1, sendCommand: async (t, p) => { sent.push({ type: t, params: p }); return reply(t, p); } }, 'all');
  return { handlers, sent };
}

test('handoff passa messaggio, picker e timeout e riporta l\'esito', async () => {
  const { handlers, sent } = build(async () => ({ done: true, action: 'done', url: 'https://app.it/dashboard' }));
  const res = await handlers.get('handoff').handler({ message: 'Complete the login', pick_element: false, timeout: 60000 });
  const m = sent.find((x) => x.type === MessageType.HANDOFF);
  assert.equal(m.params.message, 'Complete the login');
  assert.equal(m.params.timeout, 60000, 'timeout è il nome che il trasporto onora: il WS non deve scadere prima del banner');
  assert.match(res.content[0].text, /^handoff done url=https:\/\/app\.it\/dashboard/);
});

test('handoff con pick_element restituisce selettore, testo e box', async () => {
  const { handlers } = build(async () => ({ done: true, action: 'picked', url: 'https://a.it/', picked: { selector: '#save', tag: 'button', text: 'Save', rect: { x: 10, y: 20, width: 80, height: 30 } } }));
  const res = await handlers.get('handoff').handler({ message: 'Which button?', pick_element: true, timeout: 1000 });
  assert.match(res.content[0].text, /picked #save\tbutton\tSave\t@10,20 80x30/);
});

test('handoff a timeout lo dice e chiede di non ritentare alla cieca', async () => {
  const { handlers } = build(async () => ({ done: false, action: 'timeout', url: null }));
  const res = await handlers.get('handoff').handler({ message: 'x', pick_element: false, timeout: 1000 });
  assert.match(res.content[0].text, /handoff timeout\nthe user did not click/);
});

test('il timeout di trasporto di default non è sotto il minuto per handoff', () => {
  assert.ok(getTimeout(MessageType.HANDOFF) >= 30000);
});
