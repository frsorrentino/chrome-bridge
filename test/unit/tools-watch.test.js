/**
 * watch: osservazione continua in background. La consegna è un poll (tool) o
 * `chrome-bridge watch --wait` (CLI) — un server MCP non può svegliare il
 * modello, e il tool lo dice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../../server/tools.js';
import { MessageType } from '../../server/protocol.js';

function build(reply) {
  const handlers = new Map(); const sent = [];
  registerTools({ tool: (n, d, s, ...rest) => handlers.set(n, { handler: rest[rest.length - 1], desc: d }) },
    { isConnected: () => true, mode: 'primary', host: 'h', port: 1, sendCommand: async (t, p) => { sent.push({ type: t, params: p }); return reply(t, p); } }, 'all');
  return { handlers, sent };
}

test('watch add inoltra condizione, cadenza e scadenza all\'estensione', async () => {
  const { handlers, sent } = build(async () => ({ added: 'deploy', tabId: 3, until: 'match', interval_s: 60 }));
  await handlers.get('watch').handler({ action: 'add', name: 'deploy', text: 'Deployed', interval_s: 60, expires_min: 240, reload: true });
  const m = sent.find((x) => x.type === MessageType.WATCH);
  assert.equal(m.params.name, 'deploy');
  assert.equal(m.params.text, 'Deployed');
  assert.equal(m.params.reload, true);
});

test('watch poll stampa una riga per evento con ora, nome, tipo e valore', async () => {
  const { handlers } = build(async () => ({ now: 2000, events: [{ ts: 1000, name: 'price', kind: 'changed', url: 'https://a.it', value: '12€', previous: '10€' }] }));
  const res = await handlers.get('watch').handler({ action: 'poll', since: 0 });
  assert.match(res.content[0].text, /^watch events=1 now=2000\n1970-01-01T00:00:01\.000Z\tprice\tchanged\thttps:\/\/a\.it\tvalue=12€\tprevious=10€/);
});

test('watch list elenca i watch attivi', async () => {
  const { handlers } = build(async () => ({ watches: [{ name: 'ok', until: 'match', selector: '.green', interval_s: 60, checks: 4, tabId: 9 }] }));
  const res = await handlers.get('watch').handler({ action: 'list' });
  assert.match(res.content[0].text, /watches=1\nok\tmatch\t\.green\tevery 60s\tchecks=4\ttab 9/);
});

test('la descrizione dice che gli eventi non vengono spinti al modello', () => {
  const { handlers } = build(async () => ({}));
  assert.match(handlers.get('watch').desc, /collected, not pushed/);
  assert.match(handlers.get('watch').desc, /watch --wait/);
});
