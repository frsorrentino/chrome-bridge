/**
 * window_layout: salvare e ripristinare disposizioni di finestre per nome.
 *
 * È il pezzo che trasforma la geometria della 1.14.0 nel progetto multiscreen:
 * "layout lavoro" = terminale sul monitor 1, browser affiancati sul 2, un
 * comando solo. Tutto lato server, componendo GET_TABS(include_windows) e
 * VIEWPORT_RESIZE: nessun comando nuovo verso l'estensione.
 *
 * Il nodo è il matching: gli id delle finestre non sopravvivono al riavvio del
 * browser, quindi il ripristino riconosce le finestre dagli URL delle loro
 * schede (miglior sovrapposizione, a parità di tipo), non dagli id.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LAYOUTS = join(tmpdir(), `cb-layouts-test-${process.pid}.json`);
process.env.CHROME_BRIDGE_LAYOUTS_FILE = LAYOUTS;
const { registerTools } = await import('../../server/tools.js');
const { MessageType } = await import('../../server/protocol.js');

after(async () => { await rm(LAYOUTS, { force: true }); });

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

const SNAPSHOT = {
  tabs: [
    { id: 1, url: 'https://a.test/', windowId: 10, active: true },
    { id: 2, url: 'https://b.test/', windowId: 10, active: false },
    { id: 3, url: 'chrome-untrusted://terminal/html/terminal.html', windowId: 20, active: true },
  ],
  windows: [
    { id: 10, type: 'normal', state: 'normal', left: 0, top: 0, width: 800, height: 600, focused: true, tabs: 2, scriptable: true },
    { id: 20, type: 'app', state: 'maximized', left: 1920, top: 0, width: 1280, height: 800, focused: false, tabs: 1, scriptable: false },
  ],
};

test('window_layout è nel set core', () => {
  const core = new Map();
  registerTools(
    { tool: (n, _d, _s, ...rest) => core.set(n, rest[rest.length - 1]) },
    { isConnected: () => true, mode: 'primary', host: '1', port: 1, sendCommand: async () => ({}) },
    'core',
  );
  assert.ok(core.has('window_layout'));
});

test('save fotografa le finestre su disco, list le elenca', async () => {
  const { handlers } = build((type) => (type === MessageType.GET_TABS ? SNAPSHOT : {}));
  const res = await handlers.get('window_layout').handler({ action: 'save', name: 'lavoro' });
  assert.match(res.content.map((c) => c.text).join(''), /lavoro/);

  const file = JSON.parse(await readFile(LAYOUTS, 'utf8'));
  assert.ok(file.lavoro, 'layout non scritto');
  assert.equal(file.lavoro.windows.length, 2);
  assert.equal(file.lavoro.windows[1].state, 'maximized');
  assert.deepEqual(file.lavoro.windows[0].tabs, ['https://a.test/', 'https://b.test/']);

  const list = await handlers.get('window_layout').handler({ action: 'list' });
  assert.match(list.content.map((c) => c.text).join(''), /lavoro/);
});

test('restore riconosce le finestre dagli URL anche con id cambiati', async () => {
  // Prima salva, poi il "riavvio": stesse finestre, id diversi, posizioni perse.
  const { handlers } = build((type) => (type === MessageType.GET_TABS ? SNAPSHOT : {}));
  await handlers.get('window_layout').handler({ action: 'save', name: 'due' });

  const dopoRiavvio = {
    tabs: [
      { id: 51, url: 'https://a.test/', windowId: 101, active: true },
      { id: 52, url: 'https://b.test/', windowId: 101, active: false },
      { id: 53, url: 'chrome-untrusted://terminal/html/terminal.html', windowId: 202, active: true },
    ],
    windows: [
      { id: 101, type: 'normal', state: 'normal', left: 400, top: 300, width: 640, height: 480, focused: true, tabs: 2, scriptable: true },
      { id: 202, type: 'app', state: 'normal', left: 0, top: 0, width: 500, height: 400, focused: false, tabs: 1, scriptable: false },
    ],
  };
  const { handlers: h2, sent } = build((type) => (type === MessageType.GET_TABS ? dopoRiavvio : { actual: {} }));
  const res = await h2.get('window_layout').handler({ action: 'restore', name: 'due' });

  const moves = sent.filter((m) => m.type === MessageType.VIEWPORT_RESIZE);
  assert.equal(moves.length, 2, `attese 2 chiamate di posizionamento, fatte ${moves.length}`);

  // La finestra normale torna ai bounds salvati, indirizzata da una SUA scheda.
  const normal = moves.find((m) => [51, 52].includes(m.params.tab_id));
  assert.ok(normal, 'la finestra normale non è stata indirizzata da una sua scheda');
  assert.equal(normal.params.left, 0);
  assert.equal(normal.params.width, 800);
  assert.equal(normal.params.state, 'normal');

  // Quella salvata massimizzata riceve SOLO lo stato: i bounds verrebbero
  // accettati e ignorati, e il confronto richiesto/ottenuto mentirebbe.
  const maxi = moves.find((m) => m.params.tab_id === 53);
  assert.ok(maxi, 'la finestra del terminale non è stata riconosciuta');
  assert.equal(maxi.params.state, 'maximized');
  assert.equal(maxi.params.left, undefined, 'bounds inviati a una finestra da massimizzare');

  assert.match(res.content.map((c) => c.text).join(''), /"matched":\s*2|matched.*2/s);
});

test('restore dice cosa non ha ritrovato invece di tacerlo', async () => {
  const { handlers } = build((type) => (type === MessageType.GET_TABS ? SNAPSHOT : {}));
  await handlers.get('window_layout').handler({ action: 'save', name: 'tre' });

  const soloTerminale = {
    tabs: [{ id: 53, url: 'chrome-untrusted://terminal/html/terminal.html', windowId: 202, active: true }],
    windows: [{ id: 202, type: 'app', state: 'normal', left: 0, top: 0, width: 500, height: 400, focused: true, tabs: 1, scriptable: false }],
  };
  const { handlers: h2 } = build((type) => (type === MessageType.GET_TABS ? soloTerminale : { actual: {} }));
  const res = await h2.get('window_layout').handler({ action: 'restore', name: 'tre' });
  const text = res.content.map((c) => c.text).join('');
  assert.match(text, /unmatched|skipped/i, 'la finestra sparita non viene segnalata');
});

test('restore contro un\'estensione vecchia spiega il version skew', async () => {
  // L'estensione < 1.14.0 risponde a get_tabs con un array puro: niente
  // finestre. L'errore deve dire che serve l'estensione nuova, non fallire su
  // una proprietà mancante.
  const { handlers } = build(() => [{ id: 1, url: 'x', windowId: 10 }]);
  await assert.rejects(
    () => handlers.get('window_layout').handler({ action: 'save', name: 'vecchia' }),
    /1\.14|extension/i,
  );
});

test('delete rimuove il layout, restore su nome ignoto fallisce', async () => {
  const { handlers } = build((type) => (type === MessageType.GET_TABS ? SNAPSHOT : {}));
  await handlers.get('window_layout').handler({ action: 'save', name: 'temporaneo' });
  await handlers.get('window_layout').handler({ action: 'delete', name: 'temporaneo' });
  const file = JSON.parse(await readFile(LAYOUTS, 'utf8'));
  assert.ok(!file.temporaneo);

  await assert.rejects(
    () => handlers.get('window_layout').handler({ action: 'restore', name: 'inesistente' }),
    /inesistente|not found|non esiste/i,
  );
});
