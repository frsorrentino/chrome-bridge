/**
 * move_tab: sposta una scheda esistente in un'altra finestra.
 *
 * Il caso che conta è il Terminale ChromeOS: garcon apre ogni sessione in una
 * finestra nuova, e consolidarle richiede di spostare schede
 * `chrome-untrusted://terminal`. Su quello schema `chrome.tabs.create` è
 * vietato; se anche `move` lo è, l'errore va riportato **testuale**, perché è il
 * dato che stiamo cercando — un messaggio riscritto o inghiottito
 * trasformerebbe la scoperta in un mistero.
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
      sendCommand: async (type, params) => {
        sent.push({ type, params });
        if (typeof reply === 'function') return reply(type, params);
        return reply ?? {};
      },
    },
    'all',
  );
  return { handlers, sent };
}

test('move_tab è registrato nel set core', () => {
  const core = new Map();
  registerTools(
    { tool: (n, _d, _s, ...rest) => core.set(n, rest[rest.length - 1]) },
    { isConnected: () => true, mode: 'primary', host: '1', port: 1, sendCommand: async () => ({}) },
    'core',
  );
  assert.ok(core.has('move_tab'), 'spostare una scheda non è una funzione di nicchia');
});

test('tab_id è obbligatorio; window_id è opzionale perché new_window è l\'alternativa', () => {
  const { handlers } = build({});
  const { schema } = handlers.get('move_tab');
  assert.ok(schema.tab_id, 'manca tab_id');
  assert.ok(schema.window_id, 'manca window_id');
  assert.equal(schema.tab_id.isOptional?.() ?? false, false, 'tab_id deve essere obbligatorio');
  assert.equal(schema.window_id.isOptional?.(), true, 'window_id deve essere opzionale: con new_window non serve');
});

test('inoltra tab_id, window_id e index all\'estensione', async () => {
  const { handlers, sent } = build({ moved: 42, windowId: 7, index: 3 });
  await handlers.get('move_tab').handler({ tab_id: 42, window_id: 7, index: 3 });

  const msg = sent.find((m) => m.type === MessageType.MOVE_TAB);
  assert.ok(msg, 'nessun comando move_tab inviato');
  assert.equal(msg.params.tab_id, 42);
  assert.equal(msg.params.window_id, 7);
  assert.equal(msg.params.index, 3);
});

test('senza index la scheda va in fondo (-1)', async () => {
  const { handlers, sent } = build({ moved: 42 });
  await handlers.get('move_tab').handler({ tab_id: 42, window_id: 7 });
  assert.equal(sent.find((m) => m.type === MessageType.MOVE_TAB).params.index, -1);
});

test('window_type popup viene inoltrato: è la finestra senza barre per le tab da terminale', async () => {
  const { handlers, sent } = build({ moved: 42, window_type: 'popup' });
  await handlers.get('move_tab').handler({ tab_id: 42, new_window: true, window_type: 'popup' });

  const msg = sent.find((m) => m.type === MessageType.MOVE_TAB);
  assert.equal(msg.params.window_type, 'popup');
  assert.equal(msg.params.new_window, true);
});

test('un rifiuto di Chrome arriva al chiamante testuale, non riscritto', async () => {
  // È il caso chrome-untrusted://terminal: vogliamo il messaggio esatto di
  // Chrome, non una nostra parafrasi.
  const chromeMsg = 'Tabs cannot be edited right now (user may be dragging a tab).';
  const { handlers } = build(() => { throw new Error(chromeMsg); });

  await assert.rejects(
    () => handlers.get('move_tab').handler({ tab_id: 42, window_id: 7 }),
    (err) => {
      assert.equal(err.message, chromeMsg, `messaggio alterato: "${err.message}"`);
      return true;
    },
  );
});
