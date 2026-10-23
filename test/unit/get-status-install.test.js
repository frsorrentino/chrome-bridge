/**
 * La ricerca del Chrome Web Store trova di rado l'estensione: senza estensione
 * get_status dà il link diretto, così l'agente può passarlo all'utente.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../../server/tools.js';
import { EXTENSION_STORE_URL } from '../../server/protocol.js';

async function status(connected) {
  const handlers = new Map();
  registerTools(
    { tool: (n, _d, _s, ...rest) => handlers.set(n, rest[rest.length - 1]) },
    { isConnected: () => connected, mode: 'primary', host: 'h', port: 1, sendCommand: async () => ({ ok: true }) },
    'all',
    {},
  );
  const res = await handlers.get('get_status')({});
  return JSON.parse(res.content[0].text);
}

test('get_status senza estensione dà il link al Web Store, con estensione no', async () => {
  assert.equal((await status(false)).extension_install, EXTENSION_STORE_URL);
  assert.equal((await status(true)).extension_install, undefined);
});
