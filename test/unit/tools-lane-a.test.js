/**
 * Corsia A della 1.15.0: capacità senza permessi nuovi, come parametri di tool
 * esistenti.
 *
 * - create_tab/new_window con bounds: aprire direttamente sul monitor giusto,
 *   invece di aprire e poi spostare in due mosse.
 * - move_tab/new_window: estrarre una scheda in una finestra nuova posizionata,
 *   via chrome.windows.create({tabId}) — l'unico modo, perché tabs.move vuole
 *   una finestra che esiste già.
 * - tab_action discard/mute/unmute/duplicate: congelare le tab pesanti
 *   (WhatsApp/Telegram Web) e silenziare quelle che suonano durante
 *   un'automazione.
 * - manage_downloads download: il permesso "downloads" c'era già e veniva usato
 *   solo per leggere; scaricare col cookie jar del browser evita di far passare
 *   i byte dal bridge.
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

test('create_tab sa aprire una finestra nuova con posizione e dimensioni', async () => {
  const { handlers, sent } = build({ id: 5, url: 'https://x.test', title: 'x', window_id: 90 });
  const { schema, handler } = handlers.get('create_tab');
  assert.ok(schema.new_window, 'manca new_window');
  assert.ok(schema.left && schema.top && schema.width && schema.height, 'mancano i bounds');

  await handler({ url: 'https://x.test', new_window: true, left: 1920, top: 0, width: 1280, height: 800 });
  const p = sent.find((m) => m.type === MessageType.CREATE_TAB).params;
  assert.equal(p.new_window, true);
  assert.equal(p.left, 1920);
  assert.equal(p.height, 800);
});

test('create_tab senza new_window resta una scheda nella finestra corrente', async () => {
  const { handlers, sent } = build({ id: 5 });
  await handlers.get('create_tab').handler({ url: 'https://x.test' });
  const p = sent.find((m) => m.type === MessageType.CREATE_TAB).params;
  assert.ok(!p.new_window, 'new_window inviato anche se non richiesto');
});

test('move_tab con new_window estrae la scheda in una finestra posizionata', async () => {
  const { handlers, sent } = build({ moved: 42, to_window: 91 });
  const { schema, handler } = handlers.get('move_tab');
  assert.ok(schema.new_window, 'manca new_window');

  await handler({ tab_id: 42, new_window: true, left: 1920, top: 0 });
  const p = sent.find((m) => m.type === MessageType.MOVE_TAB).params;
  assert.equal(p.new_window, true);
  assert.equal(p.left, 1920);
});

test('move_tab senza né window_id né new_window fallisce prima del round trip', async () => {
  const { handlers, sent } = build({});
  await assert.rejects(
    () => handlers.get('move_tab').handler({ tab_id: 42 }),
    /window_id|new_window/,
  );
  assert.equal(sent.filter((m) => m.type === MessageType.MOVE_TAB).length, 0, 'il comando è partito comunque');
});

test('tab_action copre discard, mute, unmute e duplicate', async () => {
  const { handlers, sent } = build({ action: 'discard' });
  const { schema, handler } = handlers.get('tab_action');
  const values = schema.action._def?.entries ?? {};
  for (const a of ['discard', 'mute', 'unmute', 'duplicate']) {
    assert.ok(String(schema.action.toString?.() ?? JSON.stringify(values)).includes(a) || values[a] !== undefined, `enum senza ${a}`);
  }
  await handler({ action: 'discard', tab_id: 7 });
  assert.equal(sent.find((m) => m.type === MessageType.TAB_ACTION).params.action, 'discard');
});

test('manage_downloads sa avviare un download col cookie jar del browser', async () => {
  const { handlers, sent } = build({ started: true, id: 3 });
  const { schema, handler } = handlers.get('manage_downloads');
  assert.ok(schema.url, 'manca url');

  await handler({ action: 'download', url: 'https://x.test/f.pdf', filename: 'f.pdf' });
  const p = sent.find((m) => m.type === MessageType.MANAGE_DOWNLOADS).params;
  assert.equal(p.action, 'download');
  assert.equal(p.url, 'https://x.test/f.pdf');
  assert.equal(p.filename, 'f.pdf');
});

test('manage_downloads action=download senza url fallisce senza round trip', async () => {
  const { handlers, sent } = build({});
  await assert.rejects(() => handlers.get('manage_downloads').handler({ action: 'download' }), /url/i);
  assert.equal(sent.length, 0);
});
