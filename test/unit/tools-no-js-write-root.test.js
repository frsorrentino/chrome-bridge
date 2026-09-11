/**
 * Due interruttori di sicurezza per chi mette il bridge davanti a un team:
 *
 * - CHROME_BRIDGE_NO_JS: niente JavaScript arbitrario nella pagina. Toglie
 *   execute_js e modify_dom dallo schema, rifiuta wait_for(condition=function)
 *   e le URL javascript:/data:/vbscript: in navigate. inject_css resta: il CSS
 *   non esegue codice.
 * - CHROME_BRIDGE_WRITE_ROOT: ogni percorso scelto dal modello (save_to,
 *   output_path, export) deve stare sotto quella cartella; lo stato del server
 *   sotto ~/.config/chrome-bridge resta scrivibile. Il rifiuto arriva PRIMA
 *   del comando all'estensione: niente screenshot fatto per un file che non
 *   verrà scritto.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools } from '../../server/tools.js';

function build(options = {}, reply = () => ({})) {
  const handlers = new Map(); const sent = [];
  registerTools(
    { tool: (n, _d, s, ...rest) => handlers.set(n, { handler: rest[rest.length - 1], schema: s }) },
    { isConnected: () => true, mode: 'primary', host: 'h', port: 1, sendCommand: async (t, p) => { sent.push({ type: t, params: p }); return reply(t, p); } },
    'all',
    options,
  );
  return { handlers, sent };
}
const textOf = (res) => res.content.map((c) => c.text ?? '').join('\n');

// --- CHROME_BRIDGE_NO_JS ---

test('noJs toglie execute_js e modify_dom, lascia inject_css e il resto', () => {
  const { handlers } = build({ noJs: true });
  assert.ok(!handlers.has('execute_js'));
  assert.ok(!handlers.has('modify_dom'));
  assert.ok(handlers.has('inject_css'));
  assert.equal(handlers.size, build().handlers.size - 2);
});

test('noJs: wait_for con condition=function rifiuta prima di parlare con l\'estensione', async () => {
  const { handlers, sent } = build({ noJs: true });
  await assert.rejects(
    handlers.get('wait_for').handler({ condition: 'function', expression: 'window.ready === true' }),
    /CHROME_BRIDGE_NO_JS/,
  );
  assert.equal(sent.length, 0);
});

test('noJs: navigate rifiuta javascript:, data: e vbscript:, accetta https', async () => {
  const { handlers, sent } = build({ noJs: true }, () => ({ tabId: 1, url: 'https://example.com/' }));
  for (const url of ['javascript:alert(1)', 'JavaScript:void(0)', 'data:text/html,<script>1</script>', 'vbscript:x']) {
    await assert.rejects(handlers.get('navigate').handler({ url }), /CHROME_BRIDGE_NO_JS/, url);
  }
  assert.equal(sent.length, 0);
  await handlers.get('navigate').handler({ url: 'https://example.com/' });
  assert.equal(sent[0].type, 'navigate');
});

test('noJs si vede in get_status', async () => {
  const { handlers } = build({ noJs: true });
  const status = JSON.parse(textOf(await handlers.get('get_status').handler({})));
  assert.equal(status.js_evaluation, false);
  const plain = JSON.parse(textOf(await build().handlers.get('get_status').handler({})));
  assert.equal(plain.js_evaluation, true);
});

// --- CHROME_BRIDGE_WRITE_ROOT ---

test('writeRoot: save_to sotto la radice scrive, fuori rifiuta senza creare il file né chiamare l\'estensione', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cb-root-'));
  const outside = join(tmpdir(), `cb-outside-${process.pid}.md`);
  try {
    const { handlers, sent } = build({ writeRoot: root }, () => 'contenuto');
    const inside = join(root, 'page.md'); // save_to non crea directory: era così anche prima
    const okRes = await handlers.get('read_page').handler({ mode: 'text', save_to: inside });
    assert.match(textOf(okRes), /page\.md/);
    await access(inside);

    await assert.rejects(handlers.get('read_page').handler({ mode: 'text', save_to: outside }), /CHROME_BRIDGE_WRITE_ROOT/);
    await assert.rejects(access(outside), 'il file fuori radice non deve esistere');
    await assert.rejects(handlers.get('read_page').handler({ mode: 'text', save_to: join(root, '..', 'escape.md') }), /CHROME_BRIDGE_WRITE_ROOT/);

    const before = sent.length;
    await assert.rejects(handlers.get('save_page').handler({ output_path: outside }), /CHROME_BRIDGE_WRITE_ROOT/);
    assert.equal(sent.length, before, 'il rifiuto deve precedere il comando all\'estensione');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test('writeRoot: lo stato del server sotto ~/.config/chrome-bridge resta scrivibile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cb-root-'));
  try {
    const { handlers } = build({ writeRoot: root }, () => ({ localStorage: {}, sessionStorage: {}, cookies: [] }));
    // session_fixture salva in ~/.config/chrome-bridge/sessions: non è un
    // percorso scelto dal modello, quindi non passa dalla radice.
    const fixture = `cb-writeroot-test-${process.pid}`;
    const res = await handlers.get('session_fixture').handler({ action: 'save', name: fixture });
    assert.match(textOf(res), /saved/);
    await rm(join(homedir(), '.config', 'chrome-bridge', 'sessions', `${fixture}.json`), { force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeRoot si vede in get_status; senza opzioni tutto come prima', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cb-root-'));
  try {
    const status = JSON.parse(textOf(await build({ writeRoot: root }).handlers.get('get_status').handler({})));
    assert.equal(status.write_root, root);
    const plain = JSON.parse(textOf(await build().handlers.get('get_status').handler({})));
    assert.equal(plain.write_root, null);
    assert.ok(build().handlers.has('execute_js'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
