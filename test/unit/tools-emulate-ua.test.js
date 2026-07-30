/**
 * L'header User-Agent è già modificabile con network_rules
 * (action=modify_header): quello che manca è `navigator.userAgent` lato JS, che
 * è ciò su cui le pagine fanno branching per servire il layout mobile. Serve
 * entrambe le cose per emulare davvero un device, e la descrizione del tool deve
 * dire quale metà copre.
 *
 * Sta in emulate_media e non in un tool nuovo: stesso meccanismo (override di
 * proprietà nel MAIN world della pagina), stesso ciclo di vita (`reset` le
 * azzera tutte), e Glama già segna il conteggio dei tool 2/5.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../../server/tools.js';

function build() {
  const handlers = new Map();
  const sent = [];
  registerTools(
    { tool: (n, _d, _s, ...rest) => handlers.set(n, rest[rest.length - 1]) },
    {
      isConnected: () => true,
      mode: 'primary',
      host: '127.0.0.1',
      port: 8765,
      sendCommand: async (type, params) => { sent.push({ type, params }); return { success: true, applied: params }; },
    },
    'all',
  );
  return { handlers, sent };
}

function schemaOf(name) {
  let schema = null;
  registerTools(
    { tool: (n, _d, s) => { if (n === name) schema = s; } },
    { isConnected: () => false, mode: 'primary', host: '1', port: 1, sendCommand: async () => ({}) },
    'all',
  );
  return schema;
}

test('emulate_media accetta user_agent', () => {
  const schema = schemaOf('emulate_media');
  assert.ok(schema, 'emulate_media non registrato');
  assert.ok(schema.user_agent, 'nessun parametro user_agent: navigator.userAgent resta non emulabile');
});

test('user_agent viene inoltrato all\'estensione', async () => {
  const { handlers, sent } = build();
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
  await handlers.get('emulate_media')({ user_agent: ua });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.user_agent, ua);
});

test('la descrizione dice che copre il lato JS e rimanda a network_rules per l\'header', () => {
  let desc = '';
  registerTools(
    { tool: (n, d) => { if (n === 'emulate_media') desc = d; } },
    { isConnected: () => false, mode: 'primary', host: '1', port: 1, sendCommand: async () => ({}) },
    'all',
  );
  assert.match(desc, /navigator\.userAgent/, 'la descrizione non nomina cosa viene sovrascritto');
  assert.match(desc, /network_rules/, 'senza il rimando, l\'agente crede di aver cambiato anche l\'header');
});
