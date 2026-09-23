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
 * - lock esclusivo su <dir>/.lock (flock, lo stesso di fcntl.flock), file 0600
 *   in una cartella 0700, sostituzione atomica;
 * - un file con record di formato più nuovo non si riscrive.
 * scrub e normalize sono il porting di quelle di observe.py: il test
 * observe-parity li confronta sugli stessi testi.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync,
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

/** Legge, aggiorna e riscrive il file. Va chiamata con il lock preso. */
export function applyEntry(dir, entry, config, nowSec = Date.now() / 1000) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, `${TOOL}.jsonl`);
  const recs = readRecords(path);
  // Un file scritto da una copia più nuova (formato incompatibile): non si tocca.
  if (recs.some((r) => Number(r.v || 1) > FORMAT)) return null;
  const now = Math.round(nowSec * 1000) / 1000;
  let r = recs.find((x) => x.id === entry.id);
  if (!r) {
    r = {
      v: FORMAT, id: entry.id, tool: TOOL, count: 0, first_seen: now, examples: [], workaround: null,
      class: null, status: 'new', ...entry.fields,
    };
    recs.push(r);
  } else if (entry.fields.context) {
    r.context = entry.fields.context;
  }
  r.count = Number(r.count || 0) + 1;
  r.last_seen = now;
  r.examples = [...(r.examples || []).slice(-2), { ...entry.example, at: now }];
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
  return r;
}

// Senza flock(1) (macOS): lock a directory fra i processi Node, con un tetto
// di 2 s e la pulizia di un lock orfano più vecchio di 30 s.
async function withDirLock(dir, fn) {
  const lock = join(dir, '.lock.server');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const started = Date.now();
  for (;;) {
    try { mkdirSync(lock); break; } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 30000) rmSync(lock, { recursive: true, force: true }); } catch { /* sparito */ }
      if (Date.now() - started > 2000) return null;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

const SELF = fileURLToPath(import.meta.url);

// La scrittura gira in un figlio sotto `flock -x <dir>/.lock`: è lo stesso
// lock di fcntl.flock in observe.py, quindi server e hook non si pestano.
function writeUnderFlock(dir, entry, env) {
  return new Promise((resolve) => {
    const child = spawn('flock', ['-x', '-w', '5', join(dir, '.lock'), process.execPath, SELF, '--write'], {
      stdio: ['pipe', 'ignore', 'ignore'], env,
    });
    child.on('error', () => resolve('no-flock'));
    child.on('exit', (code) => resolve(code === 0 ? 'ok' : 'failed'));
    child.stdin.end(JSON.stringify({ dir, entry }));
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
        const how = await writeUnderFlock(dir, entry, env);
        if (how === 'no-flock') await withDirLock(dir, () => applyEntry(dir, entry, config));
      }).catch(() => { /* annotare un errore non deve mai produrne un altro */ });
      return chain;
    },
  };
}

// Modalità figlio: `node observe.js --write` con {dir, entry} su stdin.
if (process.argv[1] === SELF && process.argv[2] === '--write') {
  let input = '';
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    try {
      const { dir, entry } = JSON.parse(input);
      applyEntry(dir, entry, loadConfig(process.env));
      process.exit(0);
    } catch {
      process.exit(1);
    }
  });
}
