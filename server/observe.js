/**
 * Errori dei tool annotati in locale quando il server gira senza il plugin
 * (npm, cartella locale): nessun hook di Claude Code li vede, quindi li
 * scrive il server stesso, nel formato di claude-observe (FORMAT.md, v1).
 *
 * Con il plugin installato gli errori li scrive l'hook PostToolUseFailure
 * (observe/observe.py), che ha anche il contesto della sessione; il plugin
 * passa CHROME_BRIDGE_OBSERVE=hook e qui non si scrive nulla, altrimenti ogni
 * errore conterebbe due volte.
 *
 * Stesse regole della copia Python, perché i record finiscono nello stesso
 * file e si deduplicano per id:
 * - id = <tool[:12]>-<sha256(tool + "\0" + key)[:8]>, key = errore normalizzato;
 * - dei parametri solo nomi dei campi e lunghezze, mai i valori;
 * - errore ripulito (home, email, query degli URL, segreti, valori digitati);
 * - due lock, in quest'ordine: flock su <dir>/.lock dove c'è flock(1), poi
 *   sempre la cartella <plugin>.jsonl.lock creata con mkdir; file 0600 in una
 *   cartella 0700, sostituzione atomica;
 * - lock occupato oltre l'attesa: la voce va in <plugin>.pending.jsonl con
 *   una scrittura in append, e la incorpora il prossimo che ha il lock;
 * - un file con record di formato più nuovo non si riscrive.
 * scrub e normalize sono il porting di quelle di observe.py: il test
 * observe-parity li confronta sugli stessi testi.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, statSync,
  unlinkSync, writeSync,
} from 'node:fs';
import { homedir, release, type } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL = 'chrome-bridge';
export const FORMAT = 1;
const MCP_PREFIX = 'mcp__chrome-bridge__';
const DEFAULTS = { enabled: true, dir: '', max_records: 2000, max_days: 90 };

// \w di Python è Unicode: qui lo stesso insieme, esplicito.
const W = '[\\p{L}\\p{N}_]';

export function scrub(text, limit = 300) {
  let t = String(text ?? '');
  const home = homedir();
  if (home && home !== '/') t = t.split(home).join('~');
  t = t.replace(new RegExp(`(?:${W}|[.+-])+@(?:${W}|-)+\\.(?:${W}|[.-])+`, 'gu'), '<EMAIL>');
  t = t.replace(/(https?:\/\/[^/\s?#"'»]+)[^\s"'»]*/gu, '$1/…');
  t = t.replace(/\b(token|password|passwd|secret|api[_-]?key|authorization|bearer)("?\s*[:=]\s*|\s+)\S+/giu, '$1$2<SECRET>');
  t = t.replace(/\b(value_after|value|text)("?\s*[:=]?\s*)("[^"]*"|'[^']*'|«[^»]*»)/giu, '$1$2<STR>');
  t = t.replace(/\b(?=[A-Za-z0-9_\-+/]*\d)(?=[A-Za-z0-9_\-+/]*[A-Za-z])[A-Za-z0-9_\-+/=]{24,}\b/gu, '<SECRET>');
  return Array.from(t).slice(0, limit).join('');
}

export function normalize(text) {
  let t = scrub(text, 400);
  t = t.replace(/«[^»]*»|"[^"]*"|'[^']*'/gu, '<STR>');
  t = t.replace(new RegExp(`(~|\\.{0,2})/(?:${W}|[.\\-/~<>…])+`, 'gu'), '<PATH>');
  t = t.replace(/\d+/gu, '<N>');
  return Array.from(t.replace(/\s+/gu, ' ').trim()).slice(0, 300).join('');
}

// Di tool_input solo la forma: nomi dei campi, lunghezza dei testi, tipo del resto.
export function shape(input) {
  const out = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (typeof v === 'string') out[k] = Array.from(v).length;
    else if (typeof v === 'boolean') out[k] = 'bool';
    else if (typeof v === 'number') out[k] = 'number';
    else if (Array.isArray(v)) out[k] = `list[${v.length}]`;
    else if (v && typeof v === 'object') out[k] = `object[${Object.keys(v).length}]`;
    else out[k] = 'null';
  }
  return out;
}

export function rid(tool, key) {
  return `${tool.slice(0, 12)}-${createHash('sha256').update(`${tool}\0${key}`).digest('hex').slice(0, 8)}`;
}

const expand = (p, env) => String(p ?? '')
  .replace(/^~(?=$|\/)/, homedir())
  .replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => env[a ?? b] ?? m);

export function loadConfig(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const path = env.CLAUDE_OBSERVE_CONFIG || join(base, 'claude-observe', 'config.json');
  try {
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(path, 'utf8')) || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function boxDir(config, env = process.env) {
  if (config.dir) return expand(config.dir, env);
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'claude-observe');
}

// L'account è la cartella di config di Claude Code: il confine fra organizzazioni.
function accountName(env) {
  return basename(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
}

/** Il record come lo scriverebbe record_external/record di observe.py, più la forma dei parametri. */
export function buildEntry({ name, args, message, durationMs, version, env = process.env, cwd = process.cwd() }) {
  const call = name.startsWith(MCP_PREFIX) ? name : `${MCP_PREFIX}${name}`;
  const err = String(message ?? '');
  const key = normalize(`${call} ${err}`);
  const context = { tool_version: version || '', os: `${type()} ${release()}` };
  return {
    id: rid(TOOL, key),
    fields: {
      context, source: 'server', kind: 'error', call, error: scrub(err), key,
      account: accountName(env), project: basename(cwd),
    },
    example: { input_shape: shape(args), error_raw: scrub(err), duration_ms: durationMs ?? null, context },
  };
}

function readRecords(path) {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* riga rotta: si salta, come observe.py */ }
  }
  return out;
}

function rotate(recs, config, now) {
  const days = Number(config.max_days) || 90;
  const cap = Number(config.max_records) || 2000;
  let kept = recs.filter((r) => now - Number(r.last_seen || 0) <= days * 86400);
  if (kept.length > cap) {
    // Come observe.py: prima i record chiusi, poi i più vecchi.
    kept.sort((a, b) => ((a.status !== 'done') - (b.status !== 'done')) || (Number(a.last_seen || 0) - Number(b.last_seen || 0)));
    kept = kept.slice(kept.length - cap);
  }
  return kept;
}

// Aggiunge o aggiorna il record nella lista: la stessa logica di apply() in
// observe.py (count, last_seen, fino a tre esempi, campi scritti a mano).
function applyRecord(recs, id, fields, example, now) {
  let r = recs.find((x) => x.id === id);
  if (!r) {
    r = {
      v: FORMAT, id, tool: TOOL, count: 0, first_seen: now, examples: [], workaround: null,
      class: null, status: 'new', ...fields,
    };
    recs.push(r);
  } else {
    for (const k of ['workaround', 'class', 'note', 'context', 'security', 'severity']) if (fields[k]) r[k] = fields[k];
    if (r.status === 'done' && String(fields.source || '').startsWith('hook')) r.status = 'new';
  }
  r.count = Number(r.count || 0) + (example != null || !r.count ? 1 : 0);
  r.last_seen = Math.max(Number(r.last_seen || 0), now);
  if (example != null) r.examples = [...(r.examples || []).slice(-2), { ...example, at: now }];
  return r;
}

const pendingPath = (dir) => join(dir, `${TOOL}.pending.jsonl`);

/**
 * Legge, incorpora le voci in attesa, aggiorna e riscrive il file. Va
 * chiamata con i lock presi. null = file di formato più nuovo, non toccato.
 */
export function applyEntry(dir, entry, config, nowSec = Date.now() / 1000) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, `${TOOL}.jsonl`);
  const recs = readRecords(path);
  // Le voci rimaste in attesa (lock occupato, FORMAT.md «Pending»): si
  // spostano da parte e si applicano come appena registrate; il file preso si
  // cancella solo dopo la riscrittura.
  const pending = pendingPath(dir);
  let taken = null;
  try {
    const t = `${join(dir, `${TOOL}.pending`)}.${process.pid}.taking`;
    renameSync(pending, t);
    taken = t;
  } catch { /* nessuna voce in attesa */ }
  const takenText = taken ? readFileSync(taken, 'utf8') : '';
  // Un file scritto da una copia più nuova (formato incompatibile): non si
  // tocca, e le voci prese tornano in attesa.
  if (recs.some((r) => Number(r.v || 1) > FORMAT)) {
    if (taken) { appendFileSync(pending, takenText, { mode: 0o600 }); unlinkSync(taken); }
    return null;
  }
  for (const line of takenText.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (Number(e.v || 1) <= FORMAT && e.id) applyRecord(recs, e.id, e.fields || {}, e.example ?? null, Number(e.at) || nowSec);
    } catch { /* riga rotta: si salta */ }
  }
  const r = entry ? applyRecord(recs, entry.id, entry.fields, entry.example, Math.round(nowSec * 1000) / 1000) : null;
  const kept = rotate(recs, config, nowSec);
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, kept.map((x) => JSON.stringify(x)).join('\n') + (kept.length ? '\n' : ''));
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  if (taken) unlinkSync(taken);
  return r ?? true;
}

/**
 * Lock occupato oltre l'attesa: la voce non si perde, va in
 * <plugin>.pending.jsonl con UNA scrittura in append (atomica senza lock per
 * righe così piccole). La incorpora il prossimo scrittore che ha il lock.
 */
export function appendPending(dir, entry, nowSec = Date.now() / 1000) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({
    v: FORMAT, tool: TOOL, id: entry.id, fields: entry.fields, example: entry.example ?? null,
    at: Math.round(nowSec * 1000) / 1000,
  }) + '\n';
  const fd = openSync(pendingPath(dir), 'a', 0o600);
  try { writeSync(fd, line); } finally { closeSync(fd); }
}

// Secondo lock del protocollo (FORMAT.md, «Lock»), sempre preso: la cartella
// <plugin>.jsonl.lock creata con mkdir, atomica ovunque. Chi non ha flock(1)
// prende solo questa. Una cartella più vecchia di 10 s è di un processo
// morto; l'attesa complessiva si ferma a deadline (circa 3 s dall'inizio).
export const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 10000;
export const BUSY = Symbol('lock busy');

export async function withDirLock(dir, fn, deadline = Date.now() + LOCK_WAIT_MS) {
  const lock = join(dir, `${TOOL}.jsonl.lock`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (;;) {
    try { mkdirSync(lock); break; } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmdirSync(lock); continue; }
      } catch { continue; /* sparita nel frattempo: si riprova subito */ }
      if (Date.now() > deadline) return BUSY;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try { return fn(); } finally { try { rmdirSync(lock); } catch { /* già tolta */ } }
}

const SELF = fileURLToPath(import.meta.url);
// Codici d'uscita del figlio: lock occupato (flock -E o cartella) contro
// guasto vero. Solo il primo manda la voce in attesa.
const EXIT_BUSY = 75;

// Primo lock, dove c'è flock(1): la scrittura gira in un figlio sotto
// `flock -x <dir>/.lock`, lo stesso lock di fcntl.flock in observe.py. Le
// copie distribuite fino ad a787654 prendono solo quello: così nuove e vecchie
// convivono. Dentro, il figlio prende la cartella di lock e scrive.
function writeUnderFlock(dir, entry, env, deadline) {
  const wait = String(Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
  return new Promise((resolve) => {
    const child = spawn('flock', ['-x', '-w', wait, '-E', String(EXIT_BUSY), join(dir, '.lock'), process.execPath, SELF, '--write'], {
      stdio: ['pipe', 'ignore', 'ignore'], env,
    });
    child.on('error', () => resolve('no-flock'));
    child.on('exit', (code) => resolve(code === 0 ? 'ok' : code === EXIT_BUSY ? 'busy' : 'failed'));
    child.stdin.end(JSON.stringify({ dir, entry, deadline }));
  });
}

/**
 * L'osservatore del server, o null quando non deve scrivere: il plugin ha già
 * l'hook (CHROME_BRIDGE_OBSERVE=hook) o l'utente l'ha spento (=off).
 */
export function createObserver({ env = process.env, version = '' } = {}) {
  const mode = String(env.CHROME_BRIDGE_OBSERVE ?? '').toLowerCase();
  if (['hook', 'off', '0', 'false', 'no'].includes(mode)) return null;
  let chain = Promise.resolve();
  return {
    error(name, args, message, durationMs) {
      chain = chain.then(async () => {
        const config = loadConfig(env);
        if (config.enabled === false || config.tools?.[TOOL]?.enabled === false) return;
        const dir = boxDir(config, env);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const entry = buildEntry({ name, args, message, durationMs, version, env });
        const deadline = Date.now() + LOCK_WAIT_MS;
        let how = await writeUnderFlock(dir, entry, env, deadline);
        if (how === 'no-flock') {
          how = (await withDirLock(dir, () => applyEntry(dir, entry, config), deadline)) === BUSY ? 'busy' : 'ok';
        }
        if (how === 'busy') appendPending(dir, entry);
      }).catch(() => { /* annotare un errore non deve mai produrne un altro */ });
      return chain;
    },
  };
}

// Modalità figlio: `node observe.js --write` con {dir, entry, deadline} su stdin.
if (process.argv[1] === SELF && process.argv[2] === '--write') {
  let input = '';
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    try {
      const { dir, entry, deadline } = JSON.parse(input);
      withDirLock(dir, () => applyEntry(dir, entry, loadConfig(process.env)), deadline)
        .then((r) => process.exit(r === BUSY ? EXIT_BUSY : 0), () => process.exit(1));
    } catch {
      process.exit(1);
    }
  });
}
