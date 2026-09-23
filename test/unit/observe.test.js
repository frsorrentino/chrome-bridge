/**
 * Il server annota gli errori dei tool nel formato di claude-observe quando
 * gira senza il plugin (npm, cartella locale): nessun hook li vede.
 * Stesso file, stesso id, stesse regole di privacy della copia Python
 * (observe/observe.py): la parità si verifica facendo girare entrambe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scrub, normalize, rid, shape, applyEntry, buildEntry, createObserver, withDirLock, TOOL,
} from '../../server/observe.js';
import { registerTools } from '../../server/tools.js';

const REPO = new URL('../../', import.meta.url).pathname;
const PY = join(REPO, 'observe', 'observe.py');
const hasPython = spawnSync('python3', ['--version']).status === 0 && existsSync(PY);

const CORPUS = [
  'No tab with id: 483581071.',
  'Command wait_for_text timed out after 60000ms (tab 483581370) — the tab may be busy',
  'Unknown ref n47 — run get_interactives first',
  `Refusing to write ${homedir()}/Desktop/x.png: outside CHROME_BRIDGE_WRITE_ROOT (/tmp/a)`,
  'Element not found: #row-1042 .details-btn',
  'Failed to fetch https://shop.it/api/items?token=abc123&user=mario@example.com',
  // Chiave finta composta a runtime: scritta intera, il secret scanning di
  // GitHub rifiuta il push.
  `password: hunter2 and api_key=${['sk', 'live', '1234567890abcdefGHIJKLmn'].join('_')}`,
  'type_text mismatch: value_after "Mario Rossi" text \'segreto\' «Lazio»',
  'Città non trovata: «Roma» dopo 3 tentativi, errore è 42',
  '  spazi\tmultipli\n e a capo  ',
];

test('scrub, normalize e id coincidono con observe.py sugli stessi testi', { skip: !hasPython && 'python3 o observe/observe.py assenti' }, () => {
  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(join(REPO, 'observe'))})`,
    'import observe',
    'out = [[observe.scrub(t), observe.normalize(t), observe.rid("chrome-bridge", observe.normalize(t))] for t in json.load(sys.stdin)]',
    'print(json.dumps(out, ensure_ascii=False))',
  ].join('\n');
  const py = JSON.parse(execFileSync('python3', ['-B', '-c', script], { input: JSON.stringify(CORPUS), encoding: 'utf8' }));
  const js = CORPUS.map((t) => [scrub(t), normalize(t), rid('chrome-bridge', normalize(t))]);
  assert.deepEqual(js, py);
});

test('shape tiene nomi e lunghezze, mai i valori', () => {
  assert.deepEqual(shape({ text: 'hunter2', force: true, timeout: 5, fields: [1, 2], opts: { a: 1 }, x: null }),
    { text: 7, force: 'bool', timeout: 'number', fields: 'list[2]', opts: 'object[1]', x: 'null' });
});

test('stesso errore con numeri diversi: un record, count 2, file 0600 in cartella 0700, nessun valore', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cb-obs-')), 'claude-observe');
  const env = { CLAUDE_CONFIG_DIR: '/x/.claude' };
  const a = buildEntry({ name: 'navigate', args: { url: 'https://segreto.it/?q=hunter2' }, message: 'No tab with id: 11.', durationMs: 12, version: '1.19.0', env, cwd: '/w/med-systems-it' });
  const b = buildEntry({ name: 'navigate', args: { url: 'https://segreto.it/' }, message: 'No tab with id: 99.', version: '1.19.0', env, cwd: '/w/med-systems-it' });
  assert.equal(a.id, b.id);
  applyEntry(dir, a, {}, 1000);
  const r = applyEntry(dir, b, {}, 1001);
  const file = join(dir, `${TOOL}.jsonl`);
  const text = readFileSync(file, 'utf8');
  assert.equal(text.trim().split('\n').length, 1);
  assert.equal(r.count, 2);
  assert.equal(r.v, 1);
  assert.equal(r.source, 'server');
  assert.equal(r.call, 'mcp__chrome-bridge__navigate');
  assert.equal(r.account, '.claude');
  assert.equal(r.project, 'med-systems-it');
  assert.deepEqual(r.examples[0].input_shape, { url: 29 });
  assert.ok(!text.includes('hunter2') && !text.includes('segreto.it'), 'mai i valori dei parametri');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('al più tre esempi per record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-obs-'));
  let r;
  for (let i = 0; i < 5; i++) r = applyEntry(dir, buildEntry({ name: 'click', args: {}, message: `Element not found: #b${i}` }), {}, 2000 + i);
  assert.equal(r.count, 5);
  assert.equal(r.examples.length, 3);
});

test('un file con record di formato più nuovo non viene riscritto', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-obs-'));
  const file = join(dir, `${TOOL}.jsonl`);
  const before = JSON.stringify({ v: 2, id: 'x', tool: TOOL }) + '\n';
  writeFileSync(file, before);
  assert.equal(applyEntry(dir, buildEntry({ name: 'click', args: {}, message: 'boom' }), {}), null);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('rotazione: fuori i record più vecchi di max_days', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-obs-'));
  applyEntry(dir, buildEntry({ name: 'click', args: {}, message: 'vecchio' }), {}, 1000);
  applyEntry(dir, buildEntry({ name: 'click', args: {}, message: 'nuovo' }), { max_days: 1 }, 1000 + 2 * 86400);
  const lines = readFileSync(join(dir, `${TOOL}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.error), ['nuovo']);
});

test('createObserver: niente con il plugin (hook) o spento (off); config enabled:false non scrive', async () => {
  assert.equal(createObserver({ env: { CHROME_BRIDGE_OBSERVE: 'hook' } }), null);
  assert.equal(createObserver({ env: { CHROME_BRIDGE_OBSERVE: 'off' } }), null);
  const root = mkdtempSync(join(tmpdir(), 'cb-obs-'));
  const cfg = join(root, 'config.json');
  writeFileSync(cfg, JSON.stringify({ enabled: false }));
  const obs = createObserver({ env: { XDG_STATE_HOME: root, CLAUDE_OBSERVE_CONFIG: cfg } });
  await obs.error('click', {}, 'boom', 1);
  assert.ok(!existsSync(join(root, 'claude-observe', `${TOOL}.jsonl`)));
});

test('createObserver scrive sotto flock, e observe.py legge il record come suo', { skip: !hasPython && 'python3 o observe/observe.py assenti' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cb-obs-'));
  const cfg = join(root, 'none.json');
  const env = { ...process.env, XDG_STATE_HOME: root, CLAUDE_OBSERVE_CONFIG: cfg, CHROME_BRIDGE_OBSERVE: '' };
  const obs = createObserver({ env, version: '1.19.0' });
  await Promise.all([obs.error('navigate', { url: 'x' }, 'No tab with id: 1.', 3), obs.error('navigate', { url: 'y' }, 'No tab with id: 2.', 4)]);
  const recs = readFileSync(join(root, 'claude-observe', `${TOOL}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].count, 2);
  // observe.py (la copia del plugin) aggiunge un record allo stesso file: nessuno dei due perde l'altro.
  mkdirSync(join(root, 'cfg'), { recursive: true });
  const hook = spawnSync('python3', [PY, 'hook'], {
    input: JSON.stringify({ hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__chrome-bridge__navigate', tool_input: { url: 'z' }, error: 'No tab with id: 3.', cwd: root }),
    env: { ...env, CLAUDE_CONFIG_DIR: join(root, 'cfg') }, encoding: 'utf8',
  });
  assert.equal(hook.status, 0, hook.stderr);
  const after = readFileSync(join(root, 'claude-observe', `${TOOL}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(after.length, 1, 'stesso errore, stesso id: il record è uno');
  assert.equal(after[0].count, 3);
});

test('cartella di lock occupata: si aspetta fino alla scadenza, poi si rinuncia senza scrivere', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-obs-'));
  mkdirSync(join(dir, `${TOOL}.jsonl.lock`));
  const t0 = Date.now();
  const r = await withDirLock(dir, () => 'scritto', Date.now() + 300);
  assert.equal(r, null);
  assert.ok(Date.now() - t0 < 1500);
});

test('cartella di lock più vecchia di 10 s: è di un processo morto e si toglie', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-obs-'));
  const lock = join(dir, `${TOOL}.jsonl.lock`);
  mkdirSync(lock);
  const old = (Date.now() - 60000) / 1000;
  utimesSync(lock, old, old);
  assert.equal(await withDirLock(dir, () => 'scritto', Date.now() + 300), 'scritto');
  assert.ok(!existsSync(lock), 'tolta dopo la scrittura');
});

test('server e hook Python in parallelo sullo stesso file: nessun aggiornamento perso', { skip: !hasPython && 'python3 o observe/observe.py assenti' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cb-obs-'));
  const env = { ...process.env, XDG_STATE_HOME: root, CLAUDE_OBSERVE_CONFIG: join(root, 'none.json'), CHROME_BRIDGE_OBSERVE: '', CLAUDE_CONFIG_DIR: join(root, 'cfg') };
  const payload = (n) => JSON.stringify({ hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__chrome-bridge__navigate', tool_input: {}, error: `No tab with id: ${n}.`, cwd: root });
  const py = (n) => new Promise((res) => {
    const c = spawn('python3', ['-B', PY, 'hook'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('exit', res);
    c.stdin.end(payload(n));
  });
  // Un osservatore per scrittura: processi server diversi, come primary e relay.
  const node = (n) => createObserver({ env, version: '1.19.0' }).error('navigate', {}, `No tab with id: ${n}.`, 1);
  await Promise.all([1, 2, 3, 4, 5, 6].map((n) => (n % 2 ? py(n) : node(n))));
  const recs = readFileSync(join(root, 'claude-observe', `${TOOL}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].count, 6);
  assert.ok(!existsSync(join(root, 'claude-observe', `${TOOL}.jsonl.lock`)));
});

test('l\'id del server è quello dell\'hook: stesso call MCP completo, stesso testo che Claude Code mostra', { skip: !hasPython && 'python3 o observe/observe.py assenti' }, () => {
  // L'SDK MCP trasforma l'eccezione in isError con text = error.message: è il
  // testo che arriva al payload dell'hook (visto dal vivo: «No tab with id: 1.»).
  const server = buildEntry({ name: 'navigate', args: {}, message: 'No tab with id: 1.' });
  const script = `import sys; sys.path.insert(0, ${JSON.stringify(join(REPO, 'observe'))}); import observe; k = observe.normalize("mcp__chrome-bridge__navigate No tab with id: 1."); print(observe.rid("chrome-bridge", k))`;
  const hookId = execFileSync('python3', ['-B', '-c', script], { encoding: 'utf8' }).trim();
  assert.equal(server.fields.call, 'mcp__chrome-bridge__navigate');
  assert.equal(server.id, hookId);
});

test('il wrapper dei tool passa all\'osservatore gli errori, e l\'errore arriva comunque al chiamante', async () => {
  const seen = [];
  const handlers = new Map();
  registerTools({ tool: (n, _d, _s, ...rest) => handlers.set(n, rest[rest.length - 1]) }, {
    isConnected: () => true, mode: 'primary', port: 1,
    sendCommand: async () => { throw new Error('No tab with id: 5.'); },
  }, 'all', { observe: { error: (...a) => seen.push(a) } });
  await assert.rejects(handlers.get('navigate')({ url: 'https://a.it' }), /No tab with id: 5/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'navigate');
  assert.equal(seen[0][2], 'No tab with id: 5.');
});

// Preflight della release (npm test gira prima del tag): la copia del plugin
// non è stata toccata a mano, e dove la fonte c'è coincide con la fonte.
test('observe/observe.py coincide con la fonte (SOURCE; check.sh se claude-observe è accanto)', () => {
  const source = JSON.parse(readFileSync(join(REPO, 'observe', 'SOURCE'), 'utf8'));
  const have = createHash('sha256').update(readFileSync(PY)).digest('hex');
  assert.equal(have, source.sha256['observe.py'], 'copia modificata a mano: rimedio python3 <claude-observe>/sync.py .');
  const hooks = readFileSync(join(REPO, 'hooks', 'hooks.json'), 'utf8');
  assert.match(hooks, /observe\/observe\.py\\" hook/);
  assert.match(hooks, /observe\/observe\.py\\" session-start/);
  const check = join(REPO, '..', 'claude-observe', 'check.sh');
  if (existsSync(check)) {
    const r = spawnSync('bash', [check, REPO], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
});
