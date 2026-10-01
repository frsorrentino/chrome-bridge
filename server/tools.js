/**
 * Registra i tool MCP sul server.
 *
 * Ogni tool crea un comando WebSocket, lo invia tramite il WSManager
 * e restituisce il risultato al client MCP.
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { parse as parseHtml } from 'node-html-parser';
import { z } from 'zod';
import { runAssert } from './assertions.js';
import { ensureStubServer, addStub, clearStubs, listStubs, stubHost } from './stub-server.js';
import { MessageType, VERSION } from './protocol.js';
import { checkLinksBatch } from './link-checker.js';
import { toHar } from './har.js';
import { decodeTrackingRequests, trackingLines } from './trackers.js';
import { summarizeConsent, consentLines } from './consent.js';
import { runAudit, summarizeAudit, auditReport, AUDIT_KINDS, DEFAULT_KINDS } from './audit.js';
import { toPlaywrightTest } from './playwright-export.js';
import { createResolver } from './sourcemaps.js';
import { evaluateSecurityHeaders } from './security-headers.js';
import { windowLayout } from './layouts.js';
import { fingerprintDelta } from './effect.js';
import { analyzeTrace, traceEventsOf } from './trace-analysis.js';
import { assembleVideo } from './video.js';
import { uploadBuffer, MAX_UPLOAD_BYTES } from './upload.js';
import { cdpConnect, targetWsUrl, takeHeapSnapshot, summarizeHeap, diffHeap } from './heap.js';
import { lighthouseArgs, runLighthouse, summarizeLighthouse } from './lighthouse.js';
import { consoleLines, networkLines, interactivesLines, interactiveLine, linksLines } from './formatters.js';

const SESSIONS_DIR = join(homedir(), '.config', 'chrome-bridge', 'sessions');
// Sovrascrivibile nei test: i layout sono un file solo, non una directory.
const RECORDINGS_DIR = process.env.CHROME_BRIDGE_RECORD_DIR || join(homedir(), '.config', 'chrome-bridge', 'recordings');
const FIXTURES_DIR = process.env.CHROME_BRIDGE_FIXTURES_DIR || join(homedir(), '.config', 'chrome-bridge', 'fixtures');

// Comandi rumore per un replay: letture interne (tabSnapshot) o senza effetto
const RECORD_EXCLUDE = new Set([MessageType.GET_TABS, MessageType.PAGE_FINGERPRINT]);

// CHROME_BRIDGE_NO_JS: i tool che eseguono codice arbitrario nella pagina.
// inject_css non c'è: il CSS non esegue niente. wait_for(condition=function)
// e le URL javascript:/data: sono rifiutate nel handler, non qui.
const JS_TOOLS = new Set(['execute_js', 'modify_dom']);
// Sotto CHROME_BRIDGE_WRITE_ROOT lo stato del server resta scrivibile: non è un
// percorso scelto dal modello.
// Trace, video e report di perf_trace, screencast e lighthouse quando il
// chiamante non dà save_to.
const CAPTURES_DIR = process.env.CHROME_BRIDGE_CAPTURES_DIR || join(homedir(), '.config', 'chrome-bridge', 'captures');
const STATE_DIRS = [join(homedir(), '.config', 'chrome-bridge'), SESSIONS_DIR, RECORDINGS_DIR, FIXTURES_DIR, CAPTURES_DIR];
// upload_file mette un file del disco in un form della pagina: una pagina ostile
// con prompt injection può chiedere ~/.ssh/id_ed25519 o un .env. Senza
// CHROME_BRIDGE_READ_ROOT questi percorsi sono rifiutati; con la radice
// impostata vale solo la radice, scelta a mano da chi la imposta (il caso
// legittimo: una chiave SSL da caricare nel pannello dell'hosting).
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', join('.config', 'gcloud'), join('.config', 'gh'), join('.config', 'chrome-bridge')]
  .map((d) => join(homedir(), d));
const SECRET_FILES = /(^|[\\/])(\.env(\..*)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(_sk)?|[^\\/]*\.(pem|key|p12|pfx|jks|keystore|kdbx))$/i;

// `hint` è il parametro REALE del tool chiamante che riduce i dati. Suggerire
// max_length quando 56 tool su 59 non lo espongono mandava il modello a
// ritentare con un argomento inesistente: un turno bruciato per un consiglio
// sbagliato.
function truncateText(text, max, hint = null) {
  if (typeof text !== 'string' || text.length <= max) return text;
  const remedy = hint
    ? `use ${hint} to get less data`
    : "narrow the request (limit / max_rows / scope / selector) — this tool has no max_length";
  return text.slice(0, max) + `\n…[truncated, ${text.length - max} more chars — ${remedy}]`;
}

// Limite di default sull'output testuale di ogni tool: protegge il contesto
// del client MCP da payload fuori scala (es. buffer console/network pieni).
const DEFAULT_MAX_OUTPUT = 20000;

/**
 * Serializza compatto (niente pretty-print: solo token sprecati per il modello).
 *
 * Se il payload supera il cap, si riducono gli ELEMENTI e non i caratteri:
 * tagliare la stringa a metà di un valore produceva JSON non parsabile su ogni
 * path format=json/har (verificato: `JSON.parse` falliva con "Bad control
 * character in string literal"). Qui il risultato resta sempre valido e dichiara
 * quanto è stato omesso.
 */
function jsonText(data, max = DEFAULT_MAX_OUTPUT, hint = null) {
  const text = JSON.stringify(data);
  if (text == null || text.length <= max) return text;

  // Caso array puro
  if (Array.isArray(data)) {
    const kept = fitArray(data, max, (items) => JSON.stringify({ shown: items.length, total: data.length, items }));
    return JSON.stringify({ shown: kept.length, total: data.length, truncated: true, hint: hint ?? undefined, items: kept });
  }

  // Caso oggetto con un array dominante (requests, messages, violations, rows…)
  if (data && typeof data === 'object') {
    let key = null;
    let best = -1;
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v) && v.length > best) { key = k; best = v.length; }
    }
    if (key) {
      const full = data[key];
      const kept = fitArray(full, max, (items) => JSON.stringify({ ...data, [key]: items }));
      return JSON.stringify({
        ...data,
        [key]: kept,
        shown: kept.length,
        total: full.length,
        truncated: kept.length < full.length,
        ...(hint && kept.length < full.length ? { hint } : {}),
      });
    }
  }

  // Nessun array da ridurre: resta il taglio testuale, ma con il rimedio giusto.
  return truncateText(text, max, hint);
}

/** Il più lungo prefisso di `items` la cui serializzazione sta sotto `max` (ricerca binaria). */
function fitArray(items, max, serialize) {
  if (serialize(items).length <= max) return items;
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (serialize(items.slice(0, mid)).length <= max) lo = mid; else hi = mid - 1;
  }
  return items.slice(0, lo);
}

/**
 * Output di execute_js sotto `max` senza rompere il JSON: tagliare la
 * serializzazione a metà stringa dava «Invalid control character» a chi la
 * parsava. Una stringa si accorcia dentro il suo valore, un array per elementi
 * (jsonText), il resto diventa un prefisso dichiarato come tale.
 */
export function jsResultText(data, max) {
  const text = JSON.stringify(data);
  if (text == null || text.length <= max) return text;
  const hint = 'raise max_length, or save_to for the whole result';
  const value = data?.result;
  const wrap = (field, cut, total) => JSON.stringify({ [field]: cut, truncated: true, total_chars: total, hint });
  const fitString = (field, full) => {
    // Gli escape JSON allungano la stringa: il prefisso più lungo che sta nel
    // tetto si cerca sulla serializzazione, non sui caratteri grezzi.
    let lo = 0;
    let hi = Math.min(full.length, max);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (wrap(field, full.slice(0, mid), full.length).length <= max) lo = mid; else hi = mid - 1;
    }
    return wrap(field, full.slice(0, lo), full.length);
  };
  if (typeof value === 'string') return fitString('result', value);
  if (Array.isArray(value)) return jsonText(data, max, hint);
  return fitString('result_json_prefix', JSON.stringify(value));
}

// Nome di colonna del where → chiave della riga. Il nome esatto vince; poi
// senza maiuscole e spazi ai bordi: con {"sku": …} contro l'intestazione
// "SKU" il filtro non trovava nulla e il modello ritentava (3 run su 5 del
// benchmark del 27/09/2026).
const normCol = (c) => String(c).trim().toLowerCase();
function tableCell(row, col) {
  if (Object.hasOwn(row, col)) return row[col];
  const k = normCol(col);
  const hit = Object.keys(row).find((h) => normCol(h) === k);
  return hit === undefined ? undefined : row[hit];
}

/** Una riga (oggetto colonna→valore o array di celle) soddisfa il filtro where. */
function tableRowMatches(row, where) {
  return Object.entries(where).every(([col, needle]) => {
    const n = String(needle).toLowerCase();
    if (Array.isArray(row)) return row.some((cell) => String(cell).toLowerCase().includes(n));
    if (normCol(col) === 'any') return Object.values(row).some((cell) => String(cell).toLowerCase().includes(n));
    const cell = tableCell(row, col);
    return cell != null && String(cell).toLowerCase().includes(n);
  });
}

/** Proietta solo le colonne richieste (solo righe-oggetto; array intatti). */
function projectCols(row, columns) {
  if (Array.isArray(row)) return row;
  const o = {};
  for (const c of columns) o[c] = row[c] ?? '';
  return o;
}

/**
 * Modella la risposta grezza di extract_table lato server: filtra (where),
 * pagina (offset/max_rows) e proietta (columns) PRIMA di spedire al modello,
 * così il payload resta piccolo anche su tabelle enormi. row_count resta il
 * totale reale della tabella; match_count è quante righe passano il filtro.
 */
function shapeTable(data, { where, columns, offset = 0, max_rows = 100 } = {}) {
  let rows = Array.isArray(data.rows) ? data.rows : [];
  const total = data.row_count ?? rows.length;
  // L'estensione materializza al più scan_rows righe: con where il filtro vede
  // solo quelle, e «0 match, non troncato» sarebbe falso oltre il limite.
  const scanned = rows.length;
  const scanIncomplete = Boolean(data.truncated) || total > scanned;
  const hasWhere = where && Object.keys(where).length > 0;
  let match_count;
  if (hasWhere) {
    rows = rows.filter((r) => tableRowMatches(r, where));
    match_count = rows.length;
  }
  const available = rows.length;
  const page = rows.slice(offset, offset + max_rows);
  const projected = (columns && columns.length) ? page.map((r) => projectCols(r, columns)) : page;
  const out = {
    caption: data.caption ?? null,
    headers: data.headers ?? [],
    row_count: total,
    rows: projected,
    truncated: (offset + page.length) < available || scanIncomplete,
    tables_found: data.tables_found ?? 0,
  };
  if (hasWhere) out.match_count = match_count;
  if (hasWhere && scanIncomplete) out.scan_incomplete = `filtered the first ${scanned} of ${total} rows: raise scan_rows to search them all`;
  if (offset) out.offset = offset;
  return out;
}

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.zip': 'application/zip', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

/**
 * Dopo un'azione (click/type/fill), attende navigazione o network idle se richiesto.
 *
 * @param {(type: string, params?: object) => Promise<object>} send - invio comandi (con default tab di sessione)
 * @param {'none'|'navigation'|'networkidle'} wait_after - tipo di attesa
 * @param {number} [tab_id] - tab target
 * @returns {Promise<object|null>} risultato dell'attesa, o null se none
 */
async function applyWaitAfter(send, wait_after, tab_id, since_url) {
  if (wait_after === 'navigation') {
    // since_url: l'URL prima dell'azione. Una navigazione veloce può essere già
    // finita quando l'attesa parte: senza, l'estensione aspettava 5 s un
    // 'loading' che non arrivava più e rispondeva «No navigation started».
    return await send(MessageType.WAIT_FOR_NAVIGATION, { timeout: 15000, tab_id, ...(since_url && { since_url }) });
  }
  if (wait_after === 'networkidle') {
    return await send(MessageType.WAIT_FOR_NETWORK_IDLE, { idle_ms: 500, timeout: 15000, tab_id });
  }
  return null;
}

/**
 * Gruppi capability opt-in. I tool non elencati qui sono il set core,
 * sempre registrato. Gli altri si attivano con --caps group1,group2 o
 * CHROME_BRIDGE_CAPS (valore speciale "all" = tutto).
 */
export const TOOL_CAPS = {
  // Nel core ciò che si usa davvero: nelle 101 sessioni reali del 28/09/2026
  // ogni tool usato almeno una volta è nel core (audit, screenshot_diff,
  // network_rules, extract_table compresi). I gruppi tengono i 17 mai usati,
  // che get_status({enable}) accende a sessione in corso.
  audits: ['cookie_audit'],
  visual: ['inject_css', 'measure_spacing', 'emulate_media', 'viewport_resize'],
  // Misure di movimento e prestazioni (01/10/2026): per chi verifica le
  // animazioni di un sito, non per la navigazione di tutti i giorni.
  perf: ['animations', 'frames', 'perf_trace', 'screencast', 'lighthouse', 'heap_snapshot'],
  network: ['http_auth', 'set_geolocation', 'track_events'],
  storage: ['get_storage', 'set_storage', 'session_fixture'],
  dom: ['modify_dom', 'watch_dom', 'drag_and_drop'],
  files: ['save_page', 'manage_downloads', 'session_record'],
};

// Tool sempre caricati nel contesto quando il client carica il server per
// intero (alwaysLoad del plugin). Gli altri portano
// _meta['anthropic/alwaysLoad'] = false e restano dietro la ricerca dei tool
// (Claude Code 2.1.285+): lo schema pagato a ogni sessione scende, e un tool
// rimandato si trova con ToolSearch. Scelti dall'uso reale: ogni tool usato
// almeno 5 volte in 61 sessioni dell'autore (docs/analisi-2026-09-01.md, B.4),
// più extract_table e get_css_styles: le istruzioni del server li indicano per
// tabelle e debug, e nel benchmark appaiato del 01/10 (w128a) ogni run heavy
// caricava extract_table con ToolSearch, un turno in più, e le debug
// get_css_styles.
// CHROME_BRIDGE_ALWAYS_LOAD=all li rimette tutti, o una lista ne sceglie altri.
export const EAGER_TOOLS = [
  'execute_js', 'navigate', 'screenshot', 'find_text', 'click', 'get_interactives', 'create_tab', 'get_tabs',
  'tab_action', 'tile_windows', 'full_page_screenshot', 'extract', 'read_page', 'get_status', 'scroll',
  'wait_for', 'element_screenshot', 'type_text', 'window_layout', 'fill_form', 'extract_table', 'get_css_styles',
];
const DEFER_META = { 'anthropic/alwaysLoad': false };

// Parametri ubiqui: un solo testo, così `tab_id` non significa una cosa in un
// tool e un'altra nel gemello. test/unit/tool-parameters.test.js lo verifica.
// save_to: il payload va su disco e nel contesto resta solo il percorso più un
// sommario. Deliberatamente opt-in per chiamata e non automatico dopo ogni
// azione: scrivere file per chi non li leggerà è una tassa, e il server non
// controlla la directory di lavoro del client.
const saveToField = (what) => z.string().optional()
  .describe(`Absolute path: write ${what} there and return the path instead of the content`);

async function savedSummary(path, bytes, extra = {}) {
  await writeFile(path, bytes);
  return { content: [{ type: 'text', text: jsonText({ saved: path, bytes: bytes.length, ...extra }) }] };
}

const selectorField = (extra = '') => z.string()
  .describe(('CSS selector; ">>>" pierces shadow DOM. ' + extra).trim());
// fill_form con invio: quanto aspettare che il testo della pagina cambi, ogni
// quanto rileggerlo, quanto testo nuovo restituire al modello.
const SUBMIT_SETTLE_MS = 2000;
const SUBMIT_POLL_MS = 250;
const SUBMIT_TEXT_MAX = 800;

const waitAfter = z.enum(['none', 'navigation', 'networkidle']).optional().default('none')
  .describe('Settle before returning: navigation waits for a page load, networkidle for quiet traffic');

const tabId = z.number().optional()
  .describe('Target tab; omitted = last tab navigated in this session, else the active one');
const frameId = z.number().optional()
  .describe('Target iframe id from get_frames; omitted = main frame');

const TOOL_TO_CAP = new Map();
for (const [group, names] of Object.entries(TOOL_CAPS)) {
  for (const n of names) TOOL_TO_CAP.set(n, group);
}

/**
 * Annotations MCP, una voce per tool.
 *
 * Sono l'unico modo che l'agente ha di sapere cosa fa un tool al mondo PRIMA di
 * chiamarlo: la descrizione in prosa la legge, ma non la può confrontare. Senza
 * `readOnlyHint`, `click` e `read_page` si equivalgono al momento della scelta.
 *
 * Stanno qui e non sui singoli `server.tool(...)` perché il wrapper in
 * registerTools le applica tutte da un punto solo, e
 * `test/unit/tool-annotations.test.js` fallisce se un tool nuovo non ha la sua
 * voce — impossibile aggiungere un tool e dimenticarle.
 *
 * openWorldHint = il tool può raggiungere o farsi raggiungere da server remoti
 * (navigazione, fetch, mock di rete), non solo leggere lo stato già caricato.
 */
const ro = (open = false) => ({
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: open,
});
const rw = ({ destructive = false, idempotent = false, open = false } = {}) => ({
  readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: open,
});

export const TOOL_ANNOTATIONS = {
  // --- osservazione pura ---
  assert: ro(),
  element_screenshot: ro(),
  extract: ro(),
  extract_table: ro(),
  find_text: ro(),
  full_page_screenshot: ro(),
  get_frames: ro(),
  get_interactives: ro(),
  get_page_info: ro(),
  get_status: ro(),
  get_storage: ro(),
  get_tabs: ro(),
  manage_downloads: rw({ open: true }),  // action=download scrive un file sul disco e va in rete
  measure_spacing: ro(),
  animations: rw(),   // con action clicca, passa sopra, scorre o preme un tasto
  frames: rw(),
  perf_trace: rw({ destructive: true }),  // ricarica la pagina, sovrascrive save_to
  screencast: rw({ destructive: true }),  // sovrascrive save_to
  lighthouse: rw({ destructive: true, open: true }),  // apre e carica l'URL in una scheda nuova, sovrascrive save_to
  heap_snapshot: rw({ destructive: true }),  // forza un garbage collection, sovrascrive save_to
  monitor_network: ro(true),
  query_dom: ro(),
  get_css_styles: ro(),
  read_page: ro(),
  screenshot: ro(),
  wait_for: ro(),
  watch_dom: ro(),
  audit: ro(),
  read_form: ro(),
  watch: rw({ idempotent: true }),
  handoff: rw({ idempotent: true }),
  track_events: ro(),
  cookie_audit: rw({ idempotent: true }),
  find_setting: rw({ idempotent: true }),

  // --- interazione con la pagina ---
  click: rw({ open: true }),          // un click può navigare
  drag_and_drop: rw(),
  fill_form: rw(),  // con submit_selector INVIA: ritentare invia due volte
  hover: rw({ idempotent: true }),
  press_key: rw(),
  scroll: rw(),
  type_text: rw({ idempotent: true }),
  upload_file: rw(),

  // --- modifica di pagina, tab o resa ---
  dismiss_overlays: rw({ idempotent: true }),
  emulate_media: rw({ idempotent: true }),
  handle_dialogs: rw({ idempotent: true }),
  inject_css: rw({ idempotent: true }),
  modify_dom: rw({ idempotent: true }),
  screenshot_diff: rw({ idempotent: true }),
  viewport_resize: rw({ idempotent: true }),
  create_tab: rw({ open: true }),
  move_tab: rw({ idempotent: true }),   // rispostare dove è già = stesso esito
  tile_windows: rw({ idempotent: true }),
  window_layout: rw({ destructive: true, idempotent: true }),  // save sovrascrive l'omonimo, restore sposta finestre
  navigate: rw({ idempotent: true, open: true }),
  tab_action: rw({ destructive: true, open: true }),  // close chiude una tab dell'utente

  // --- rete, identità, posizione ---
  http_auth: rw({ idempotent: true, open: true }),
  network_rules: rw({ idempotent: true, open: true }),
  set_geolocation: rw({ idempotent: true }),

  // --- codice arbitrario ---
  execute_js: rw({ destructive: true, open: true }),

  // http_request non è read-only: un POST cambia lo stato del server remoto, e
  // con save_to scrive un file. destructive perché sovrascrive save_to senza
  // chiedere.
  http_request: rw({ destructive: true, open: true }),

  // --- stato che può essere distrutto o sovrascritto ---
  clipboard: rw({ idempotent: true }),
  read_console: rw({ destructive: true }),                        // clear:true cancella il buffer
  save_page: rw({ destructive: true, idempotent: true }),         // sovrascrive output_path
  session_fixture: rw({ destructive: true, idempotent: true }),   // restore sovrascrive cookie e storage
  session_record: rw(),
  set_storage: rw({ destructive: true, idempotent: true }),
};

/**
 * Registra tutti i tool MCP.
 *
 * @param {import('@modelcontextprotocol/sdk/server/index.js').McpServer} server - MCP Server
 * @param {import('./ws-manager.js').WSManager} wsManager - WebSocket manager
 * @param {string} [caps='all'] - 'all', 'core', o lista di gruppi "audits,visual"
 * @param {{noJs?: boolean, writeRoot?: string|null, readRoot?: string|null}} [options] - CHROME_BRIDGE_NO_JS / CHROME_BRIDGE_WRITE_ROOT / CHROME_BRIDGE_READ_ROOT
 */
/** Procedura leggibile da un'osservazione: un passo per riga, i campi sensibili marcati come passo umano. */
function observedProcedure(name, d) {
  const lines = [`# ${name}`, '', `Observed on ${new Date(d.started_at ?? Date.now()).toISOString()}${d.final_url ? `, ended on ${d.final_url}` : ''}.`, 'Replay: `chrome-bridge replay --file <name>.jsonl --vars \'{"field":"value"}\'` — placeholders {{field}} are filled from --vars; sensitive ones are for the human.', ''];
  let n = 0;
  for (const st of d.steps ?? []) {
    n += 1;
    const h = st.human ?? {};
    if (st.command === 'navigate') lines.push(`${n}. Open ${st.params.url}${h.label ? ` («${h.label}»)` : ''}`);
    else if (st.command === 'click') lines.push(`${n}. Click «${h.label || st.params.selector}» (\`${st.params.selector}\`)`);
    else if (st.command === 'type_text') lines.push(h.sensitive ? `${n}. [HUMAN] Enter ${h.label || 'the value'} in \`${st.params.selector}\` — not recorded` : `${n}. Fill «${h.label || st.params.selector}» (\`${st.params.selector}\`) with ${st.params.text}`);
    else if (st.command === 'press_key') lines.push(`${n}. Press ${st.params.key} in «${h.label || st.params.selector}»`);
    else lines.push(`${n}. ${st.command} ${JSON.stringify(st.params)}`);
  }
  return lines.join('\n') + '\n';
}

export function registerTools(server, wsManager, caps = 'all', options = {}) {
  const startedAt = Date.now();
  const noJs = Boolean(options.noJs);
  const WRITE_ROOT = options.writeRoot ? resolve(String(options.writeRoot)) : null;
  // Rifiuta PRIMA del comando all'estensione: niente screenshot fatto per un
  // file che non verrà scritto. Il percorso torna com'è, così i chiamanti
  // possono usarlo inline.
  const guardWrite = (p) => {
    if (!WRITE_ROOT || p == null) return p;
    const abs = resolve(String(p));
    const inside = (root) => abs === root || abs.startsWith(root + sep);
    if (inside(WRITE_ROOT) || STATE_DIRS.some((d) => inside(resolve(d)))) return p;
    throw new Error(`Refusing to write ${abs}: outside CHROME_BRIDGE_WRITE_ROOT (${WRITE_ROOT})`);
  };
  const READ_ROOT = options.readRoot ? resolve(String(options.readRoot)) : null;
  // realpath: un symlink innocuo verso ~/.ssh non deve passare.
  const guardRead = async (p) => {
    const abs = await realpath(resolve(String(p)));
    const inside = (root) => abs === root || abs.startsWith(root + sep);
    if (READ_ROOT) {
      if (inside(READ_ROOT)) return abs;
      throw new Error(`Refusing to read ${abs}: outside CHROME_BRIDGE_READ_ROOT (${READ_ROOT})`);
    }
    if (SECRET_DIRS.some(inside) || SECRET_FILES.test(abs)) {
      throw new Error(`Refusing to upload ${abs}: looks like a key or credential file. To upload it on purpose, set CHROME_BRIDGE_READ_ROOT to a folder that contains it.`);
    }
    return abs;
  };
  const activeCaps = caps === 'all'
    ? ['core', ...Object.keys(TOOL_CAPS)]
    : ['core', ...String(caps).split(',').map((s) => s.trim()).filter((s) => s && s !== 'core')];
  // Tool dei gruppi non attivi: registrati ma spenti, così get_status({enable})
  // li accende a sessione in corso (tools/list_changed) invece di chiedere un
  // riavvio con --caps. Nome del tool → handle dell'SDK.
  const dormant = new Map();
  // Impronta dell'ultimo screenshot per scheda (screenshot if_changed).
  const lastShot = new Map();

  // Un errore del tool (eccezione, o risultato isError) va all'osservatore,
  // che lo annota in locale senza i valori dei parametri (server/observe.js).
  // L'errore arriva comunque al chiamante, uguale.
  const observer = options.observe ?? null;
  const observed = (name, handler) => (observer ? async (args, extra) => {
    const t0 = Date.now();
    try {
      const out = await handler(args, extra);
      if (out?.isError) {
        const text = (out.content ?? []).find((c) => c.type === 'text')?.text ?? '';
        observer.error(name, args, text, Date.now() - t0);
      }
      return out;
    } catch (err) {
      observer.error(name, args, err?.message ?? String(err), Date.now() - t0);
      throw err;
    }
  } : handler);

  // Ogni registrazione passa da qui: il filtro capability scarta i tool opt-in
  // fuori dai gruppi attivi, e le annotations vengono applicate da TOOL_ANNOTATIONS.
  // Un solo wrapper per entrambe le cose, altrimenti con caps != 'all' le
  // annotations sparivano insieme al filtro.
  // Il server MCP a basso livello (capability del client, elicitation): il
  // wrapper qui sotto espone solo tool().
  const lowLevelServer = server.server ?? null;
  {
    const target = server;
    const eagerOpt = options.alwaysLoad ?? null;
    const eager = eagerOpt === 'all' ? null
      : new Set(eagerOpt ? String(eagerOpt).split(',').map((s) => s.trim()).filter(Boolean) : EAGER_TOOLS);
    const enabled = caps !== 'all'
      ? new Set(String(caps).split(',').map((s) => s.trim()).filter(Boolean))
      : null;
    server = {
      tool(name, desc, schema, handler) {
        if (noJs && JS_TOOLS.has(name)) return;
        const group = enabled ? TOOL_TO_CAP.get(name) : null;
        const inactive = Boolean(group && !enabled.has(group) && !enabled.has('all'));
        // Un server senza disable() (i finti dei test, measure-schema) non può
        // tenere un tool spento: lì il tool inattivo non si registra, come prima.
        if (inactive && typeof target.sendToolListChanged !== 'function') return;
        const annotations = TOOL_ANNOTATIONS[name];
        const run = observed(name, handler);
        // Un tool senza voce resta registrato (meglio di un crash all'avvio):
        // è il test tool-annotations a segnalarlo.
        const reg = annotations ? target.tool(name, desc, schema, annotations, run) : target.tool(name, desc, schema, run);
        // Assegnato e non con update(): update() manderebbe tools/list_changed
        // per ogni tool, prima ancora che il client sia collegato.
        if (eager && !eager.has(name) && reg && typeof reg === 'object') reg._meta = { ...(reg._meta ?? {}), ...DEFER_META };
        if (inactive) { reg.disable(); dormant.set(name, reg); }
      },
    };
  }

  // Ultimo tab toccato da navigate/create_tab in questa sessione: è il default
  // dei comandi senza tab_id esplicito. "Tab attivo" è una landmine quando
  // l'utente usa Chrome durante l'automazione (il comando colpirebbe la pagina
  // che sta guardando lui, non quella navigata dall'agente).
  let sessionTabId = null;
  // Tab create da questa sessione: un altro processo server (un'altra sessione
  // Claude, un subagent con il proprio MCP) non le vede come sue. Senza il
  // permesso tabGroups non c'è un gruppo colorato, ma c'è un perimetro.
  const ownedTabs = new Set();
  const sourceMaps = createResolver(async (url) => { const r = await send(MessageType.HTTP_REQUEST, { url, method: 'GET' }); if (!r || r.status >= 400) throw new Error(`HTTP ${r?.status}`); return r.body ?? ''; });

  // Recording attivo: { name, file }. I comandi (senza tab_id, che in un
  // replay sarebbe stale) vengono appesi come jsonl replayabile dal CLI.
  let recording = null;
  // Gli append del recording erano fire-and-forget: un comando registrato
  // poteva non essere ancora sul disco quando session_record stop tornava, e
  // uno step mancante rende un replay silenziosamente sbagliato. La catena
  // serializza le scritture e stop() la attende.
  let recordChain = Promise.resolve();
  // >0 mentre un tool composito (assert) esegue query interne che nel
  // recording sarebbero rumore: registra il tool, non le sue query.
  let recordSuppressed = 0;

  const send = async (type, params = {}) => {
    if (recording && !recordSuppressed && !RECORD_EXCLUDE.has(type)) {
      const { tab_id: _tab, ...rest } = params;
      const file = recording.file;
      const line = JSON.stringify({ command: type, params: rest }) + '\n';
      recordChain = recordChain.then(() => appendFile(file, line)).catch(() => {});
    }
    const implicitTab = params.tab_id == null && sessionTabId != null;
    if (implicitTab) params = { ...params, tab_id: sessionTabId };
    try {
      return await wsManager.sendCommand(type, params);
    } catch (err) {
      // Se l'utente chiude a mano la tab di sessione, ogni comando successivo
      // fallisce fino al prossimo navigate. Un solo ritentativo sulla tab
      // attiva salva un turno intero al modello.
      const gone = /No tab with id|No active tab|No tab found/i.test(err?.message ?? '');
      if (!gone || !implicitTab) throw err;
      sessionTabId = null;
      const { tab_id: _drop, ...retry } = params;
      const data = await wsManager.sendCommand(type, retry);
      return data;
    }
  };

  // Registro ref → selector per tab, popolato da get_interactives, dalla
  // preview di navigate e dai vicini di find_text. Permette click/type_text/
  // hover per ref (n1, n2…) senza ripetere selettori lunghi.
  // Un selettore tiene lo stesso ref finché la pagina non cambia, e un numero
  // non viene mai riassegnato: prima ogni chiamata di scoperta ripartiva da n1
  // sulla stessa mappa, e dopo un find_text n3 indicava un altro elemento —
  // il click andava a segno sull'elemento sbagliato senza errori.
  const interactivesRefs = new Map();
  const REFS_MAX = 2000;

  const refsKey = (tab_id) => tab_id ?? sessionTabId ?? 'active';

  function refRegistry(tab_id) {
    const key = refsKey(tab_id);
    let reg = interactivesRefs.get(key);
    if (!reg) {
      reg = { next: 1, floor: 1, bySel: new Map(), byRef: new Map() };
      interactivesRefs.set(key, reg);
    }
    return reg;
  }

  // Assegna i ref agli elementi (in place). Solo gli elementi con selector
  // ricevono un ref: senza, non ci sarebbe nulla da risolvere.
  // Il ref ricorda anche il frame: lo stesso "#save" in due frame riceveva lo
  // stesso n1, e un click col solo ref andava nel frame principale.
  const selKey = (frame, selector) => `${frame}\u0000${selector}`;
  function assignRefs(tab_id, elements, frame_id) {
    const reg = refRegistry(tab_id);
    const frame = frame_id ?? 0;
    for (const e of elements) {
      if (!e.selector) continue;
      let ref = reg.bySel.get(selKey(frame, e.selector));
      if (!ref) {
        ref = `n${reg.next++}`;
        reg.bySel.set(selKey(frame, e.selector), ref);
        reg.byRef.set(ref, { selector: e.selector, frame });
      }
      e.ref = ref;
    }
    while (reg.byRef.size > REFS_MAX) {
      const [oldRef, old] = reg.byRef.entries().next().value;
      reg.byRef.delete(oldRef);
      reg.bySel.delete(selKey(old.frame, old.selector));
    }
    return reg.byRef.size;
  }

  // Liste di get_interactives ricordate per il diff con since: per ogni
  // cursore la chiave della richiesta, il floor dei ref (una navigazione lo
  // alza) e la firma di ogni elemento senza la posizione, così uno scroll non
  // segna tutto come cambiato. Poche liste: il diff serve al giro successivo.
  const interactivesSnaps = new Map();
  const SNAPS_MAX = 20;
  let snapSeq = 0;

  function interactivesDiff(since, { tab_id, frame_id, scope, visible_only }, elements) {
    const reg = refRegistry(tab_id);
    const key = [refsKey(tab_id), frame_id ?? 0, scope ?? '', visible_only ?? true].join('\u0000');
    const sigs = new Map(elements.filter((e) => e.ref).map((e) => [e.ref, interactiveLine(e, { rect: false })]));
    const cursor = `i${++snapSeq}`;
    interactivesSnaps.set(cursor, { key, floor: reg.floor, sigs });
    while (interactivesSnaps.size > SNAPS_MAX) interactivesSnaps.delete(interactivesSnaps.keys().next().value);
    if (!since) return { cursor };
    const prev = interactivesSnaps.get(since);
    if (!prev) return { cursor, note: `cursor ${since} unknown or expired: full list` };
    if (prev.key !== key) return { cursor, note: `cursor ${since} is for another tab, frame, scope or visible_only: full list` };
    if (prev.floor !== reg.floor) return { cursor, note: 'the page navigated since the cursor: full list, new refs' };
    const added = []; const changed = [];
    for (const e of elements) {
      if (!e.ref) continue;
      const old = prev.sigs.get(e.ref);
      if (old == null) added.push(e);
      else if (old !== sigs.get(e.ref)) changed.push(e);
    }
    const removed = [...prev.sigs.keys()].filter((r) => !sigs.has(r));
    return { cursor, diff: { added, changed, removed } };
  }

  // Una navigazione cambia pagina: i selettori vecchi potrebbero trovare altro.
  // La mappa si svuota ma il contatore no, così un ref vecchio dà errore
  // invece di indicare un elemento nuovo con lo stesso numero.
  function resetRefs(tab_id) {
    const reg = refRegistry(tab_id);
    reg.bySel.clear();
    reg.byRef.clear();
    reg.floor = reg.next;
  }

  // Selettore e frame del bersaglio. Con un ref il frame viene dal ref; un
  // frame_id esplicito diverso è un errore, non un click altrove.
  function resolveTarget(selector, ref, tab_id, frame_id) {
    if (selector) return { selector, frame_id };
    if (ref) {
      const reg = interactivesRefs.get(refsKey(tab_id));
      const entry = reg?.byRef.get(ref);
      if (!entry) {
        const num = Number(String(ref).replace(/^n/, ''));
        const why = !reg || reg.next === 1 ? 'no refs issued for this tab yet'
          : num >= reg.next ? `refs issued so far go up to n${reg.next - 1}`
            : num < reg.floor ? 'it was issued before the last navigate, which resets refs'
              : 'it was evicted from the ref cache';
        throw new Error(`Unknown ref ${ref} (${why}) — run get_interactives or find_text again`);
      }
      if (frame_id != null && frame_id !== entry.frame) {
        throw new Error(`ref ${ref} belongs to frame ${entry.frame}, not frame ${frame_id}: pass that frame_id or omit it`);
      }
      return { selector: entry.selector, frame_id: entry.frame || frame_id };
    }
    throw new Error('Either selector or ref is required');
  }

  // Impronta della pagina per il delta post-azione (page_changed): DOM in
  // pochi interi più url/title. Un'estensione vecchia o una pagina non
  // iniettabile (chrome://) tornano a url/title da get_tabs: nessun errore,
  // solo meno dettaglio.
  async function tabSnapshot(tab_id, settle) {
    try {
      const fp = await send(MessageType.PAGE_FINGERPRINT, { tab_id, ...(settle && { settle }) });
      if (fp && typeof fp === 'object') return fp;
    } catch { /* fallback sotto */ }
    try {
      const tabs = await send(MessageType.GET_TABS);
      const list = Array.isArray(tabs) ? tabs : [];
      const eff = tab_id ?? sessionTabId;
      const tab = eff != null ? list.find((t) => t.id === eff) : list.find((t) => t.active);
      return tab ? { url: tab.url, title: tab.title } : null;
    } catch { return null; }
  }

  // Impronta «dopo» un'azione: l'estensione aspetta che il DOM si fermi
  // (settled_ms), di solito ~50 ms. Un'estensione vecchia non conosce settle
  // e risponde subito: allora la pausa fissa di prima e una seconda lettura.
  const SETTLE = { quiet_ms: 50, max_ms: 250 };
  async function settledSnapshot(tab_id) {
    const fp = await tabSnapshot(tab_id, SETTLE);
    if (fp && 'settled_ms' in fp) return fp;
    await new Promise((r) => setTimeout(r, 150));
    return tabSnapshot(tab_id);
  }

  // Testo della pagina (o del frame) per il confronto prima/dopo un invio.
  // Resta nel server: al modello arriva solo la differenza.
  async function pageText(tab_id, frame_id) {
    try {
      const t = await send(MessageType.READ_PAGE, { mode: 'text', tab_id, frame_id });
      return typeof t === 'string' ? t : null;
    } catch { return null; }
  }

  // Esito di un invio: url, titolo e le righe di testo che la pagina ha
  // guadagnato. Il testo può arrivare dopo (fetch, redirect): si rilegge per
  // al più SUBMIT_SETTLE_MS e, al primo cambiamento, una volta ancora dopo una
  // pausa breve, perché un «Invio in corso…» non venga preso per l'esito.
  const cutText = (t, max) => (t.length <= max ? t : `${t.slice(0, max)}…[+${t.length - max} chars: read_page for the rest]`);

  async function submitOutcome(tab_id, frame_id, textBefore, snap) {
    const deadline = Date.now() + SUBMIT_SETTLE_MS;
    let text = await pageText(tab_id, frame_id);
    while ((text == null || text === textBefore) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SUBMIT_POLL_MS));
      text = await pageText(tab_id, frame_id);
    }
    if (text != null && text !== textBefore) {
      await new Promise((r) => setTimeout(r, SUBMIT_POLL_MS));
      text = (await pageText(tab_id, frame_id)) ?? text;
    }
    const seen = new Set(textBefore.split('\n').map((l) => l.trim()));
    const gained = text == null ? [] : text.split('\n').map((l) => l.trim()).filter((l) => l && !seen.has(l));
    const snapNow = await tabSnapshot(tab_id) ?? snap;
    return {
      url: snapNow?.url ?? null,
      title: snapNow?.title ?? null,
      // truncateText suggerirebbe parametri che fill_form non ha: taglio secco.
      new_text: gained.length ? cutText(gained.join('\n'), SUBMIT_TEXT_MAX) : null,
      ...(!gained.length && { note: text === textBefore ? 'page text unchanged after submit' : 'page text unavailable' }),
    };
  }

  // Delta compatto dopo un'azione: solo ciò che è cambiato (url, title, conteggi
  // DOM con segno, fuoco). Costa pochi token quando scatta, zero quando la
  // pagina è stabile, e risparmia al client lo screenshot per capire "cosa è
  // successo".
  const pageDelta = fingerprintDelta;

  // Anteprima compatta dei primi interactives (con ref), allegata a navigate:
  // il client può agire subito senza un giro di discovery. Cappata e best-effort.
  async function interactivesPreview(tab_id, limit = 12) {
    try {
      const data = await send(MessageType.GET_INTERACTIVES, { limit, visible_only: true, tab_id });
      const elements = data?.elements ?? [];
      assignRefs(tab_id, elements);
      return elements.some((e) => e.ref) ? truncateText(interactivesLines(data), 1500) : null;
    } catch { return null; }
  }

  // Un'azione che apre o mostra qualcosa (menu, dialog, pannello, pagina
  // nuova) allega i ref degli interactives visibili: senza, il modello
  // spendeva un turno di get_interactives per trovare cosa era comparso.
  const grew = (v) => typeof v === 'string' && v.startsWith('+');
  const revealed = (d) => Boolean(d && (d.url || grew(d.open) || grew(d.expanded) || grew(d.dialogs)
    || (grew(d.nodes) && Number(d.nodes) >= 5)));
  const withPreview = async (text, changed, tab_id) => {
    const preview = revealed(changed) ? await interactivesPreview(tab_id) : null;
    return preview ? `${text}\n${preview}` : text;
  };

  // Problemi della pagina appena caricata, in poche righe e solo se ci sono:
  // primo errore di console già riportato al sorgente, richieste fallite. Nel
  // benchmark debug del 28/09 il modello spendeva due turni (read_console,
  // monitor_network) per scoprirli. Best-effort: su errore, niente.
  async function pageProblems(tab_id) {
    // Letture interne: in un recording sarebbero rumore nel replay.
    recordSuppressed += 1;
    try {
      await send(MessageType.WAIT_FOR_NETWORK_IDLE, { idle_ms: 100, timeout: 1500, tab_id }).catch(() => {});
      const [con, net] = await Promise.all([
        send(MessageType.READ_CONSOLE, { level: 'error', limit: 2, tab_id }).catch(() => null),
        send(MessageType.MONITOR_NETWORK, { limit: 100, tab_id }).catch(() => null),
      ]);
      const errs = Array.isArray(con?.messages) ? con.messages : [];
      const failed = (Array.isArray(net?.requests) ? net.requests : []).filter((r) => r && (r.error || r.status >= 400));
      if (!errs.length && !failed.length) return null;
      const cut = (t, n) => (t.length > n ? `${t.slice(0, n)}…` : t);
      const lines = [`problems: ${con?.count ?? errs.length} console error(s), ${failed.length} failed request(s)`];
      for (const [i, m] of errs.entries()) {
        let text = (m.args ?? []).map(String).join(' ');
        if (i === 0) text = await sourceMaps.resolve(text).catch(() => text);
        lines.push(`  error: ${cut(text.replace(/\n\s*/g, ' | '), i === 0 ? 400 : 160)}`);
      }
      for (const r of failed.slice(0, 3)) lines.push(`  ${r.method ?? 'GET'} ${cut(String(r.url), 120)} → ${r.status ?? `ERR(${r.error})`}`);
      lines.push('  (read_console / monitor_network for the rest)');
      return lines.join('\n');
    } catch { return null; } finally { recordSuppressed -= 1; }
  }

  // --- get_status ---
  server.tool(
    'get_status',
    'Bridge status: extension connection, server mode (primary/relay), host, port, server and extension versions, js_evaluation '
      + '(false under --no-js), write_root and read_root, caps_active and caps_available (a tool missing from the list lives in an '
      + 'inactive cap), session_tab_id (the implicit tab), owned_tabs (created by this session), uptime_sec. '
      + 'enable switches caps on for this session, no restart. Optional caps: '
      + `${Object.entries(TOOL_CAPS).map(([g, t]) => `${g} (${t.join(', ')})`).join('; ')}.`,
    {
      enable: z.array(z.enum(['all', ...Object.keys(TOOL_CAPS)])).optional()
        .describe('Caps to switch on now, all in one call; "all" = every cap'),
    },
    async ({ enable } = {}) => {
      let enabledNow;
      if (enable?.length) {
        const groups = enable.includes('all') ? Object.keys(TOOL_CAPS) : enable;
        enabledNow = [];
        for (const g of groups) {
          for (const name of TOOL_CAPS[g]) {
            const reg = dormant.get(name);
            if (!reg) continue;
            reg.enable();
            dormant.delete(name);
            enabledNow.push(name);
          }
          if (!activeCaps.includes(g)) activeCaps.push(g);
        }
      }
      return {
        content: [{
          type: 'text',
          text: jsonText({
            connected: wsManager.isConnected(),
            mode: wsManager.mode,
            host: wsManager.host,
            port: wsManager.port,
            version: VERSION,
            extension_version: wsManager.extVersion ?? null,
            ...(wsManager.browser && { browser: wsManager.browser.label }),
            ...(wsManager.refusedBrowsers?.length && { refused_browsers: wsManager.refusedBrowsers.map((r) => `${r.label} at ${r.at}`) }),
            // Un agente che non trova accessibility_audit non aveva modo di
            // scoprire che esiste ma è in un gruppo disattivato.
            js_evaluation: !noJs,
            write_root: WRITE_ROOT,
            read_root: READ_ROOT,
            caps_active: activeCaps,
            caps_available: ['core', ...Object.keys(TOOL_CAPS)],
            session_tab_id: sessionTabId,
            owned_tabs: [...ownedTabs],
            uptime_sec: Math.round((Date.now() - startedAt) / 1000),
            ...(enabledNow && { enabled: enabledNow }),
          }),
        }],
      };
    }
  );

  // --- get_tabs ---
  server.tool(
    'get_tabs',
    'List every open tab with id, url, title, active flag and mine (created by this session). Read-only. Find a tab_id when the implicit '
      + 'target is not the one you mean. include_windows adds position, size, state and type of each window — needed before moving or tiling. '
      + 'Session tabs gone since the last call come back once in closed_session_tabs with the reason (closed, window_closed, replaced, closed_by_bridge).',
    {
      include_windows: z.boolean().optional().default(false)
        .describe('Also return the windows with bounds, state, type and tab count'),
    },
    async ({ include_windows }) => {
      // `ended` = le schede che il server sa sue: l'estensione dà il motivo di
      // quelle che non trova più. Senza schede di sessione la risposta resta
      // quella di sempre.
      const data = await send(MessageType.GET_TABS, {
        include_windows: include_windows === true,
        ...(ownedTabs.size ? { ended: [...ownedTabs] } : {}),
      });
      const list = Array.isArray(data) ? data : (data?.tabs ?? []);
      const windows = Array.isArray(data) ? null : data?.windows;
      for (const t of list) if (ownedTabs.has(t.id)) t.mine = true;
      const missing = [...ownedTabs].filter((id) => !list.some((t) => t.id === id));
      const shaped = windows ? { tabs: list, windows } : list;
      if (!missing.length) return { content: [{ type: 'text', text: jsonText(shaped) }] };

      // Un'estensione precedente ignora `ended` e risponde con l'array: motivo ignoto.
      const ended = (!Array.isArray(data) && data?.ended) || {};
      const closed = missing.map((id) => ({ id, ...(ended[id] ?? { reason: 'unknown' }) }));
      for (const c of closed) {
        ownedTabs.delete(c.id);
        const successor = c.replaced_by != null ? list.find((t) => t.id === c.replaced_by) : null;
        // Scheda sostituita da Chrome: resta della sessione con il nuovo id.
        if (successor) { ownedTabs.add(successor.id); successor.mine = true; }
        if (sessionTabId === c.id) sessionTabId = successor?.id ?? null;
      }
      return { content: [{ type: 'text', text: jsonText({ tabs: list, ...(windows ? { windows } : {}), closed_session_tabs: closed }) }] };
    }
  );

  // --- navigate ---
  server.tool(
    'navigate',
    'Navigate a Chrome tab to a URL. Returns a preview of interactive elements with refs usable in click/type_text/hover.',
    {
      url:    z.string().describe('Absolute URL, or a path resolved against the current page'),
      tab_id: tabId,
    },
    async ({ url, tab_id }) => {
      if (noJs && /^\s*(javascript|data|vbscript):/i.test(url)) {
        throw new Error(`Refusing to navigate to ${url.slice(0, 40)}: JavaScript evaluation is disabled (CHROME_BRIDGE_NO_JS)`);
      }
      const data = await send(MessageType.NAVIGATE, { url, tab_id });
      // Il tab navigato diventa il default di sessione per i comandi successivi
      if (data?.tabId != null) sessionTabId = data.tabId;
      resetRefs(data?.tabId ?? tab_id);
      const [preview, problems] = await Promise.all([interactivesPreview(data?.tabId ?? tab_id), pageProblems(data?.tabId ?? tab_id)]);
      return {
        content: [{
          type: 'text',
          text: jsonText(data) + (problems ? `\n${problems}` : '') + (preview ? `\n${preview}` : ''),
        }],
      };
    }
  );

  // --- screenshot ---
  // Larghezze dei preset, le stesse di viewport_resize nell'estensione.
  const PRESET_WIDTHS = { mobile: 375, tablet: 768, desktop: 1440 };
  server.tool(
    'screenshot',
    'Screenshot of the visible viewport only (PNG), at the current scroll position, or one per viewport preset with presets. Read-only. '
      + 'Activates the tab in the background without stealing window focus, then restores the previous tab. '
      + 'Downscaled to ≤1568px: for fine print, element_screenshot with scale.',
    {
      tab_id: tabId,
      save_to: saveToField('the PNG'),
      presets: z.array(z.enum(['mobile', 'tablet', 'desktop'])).optional().describe('Resizes the window per preset, then restores it; not phone emulation. A refused width is reported, not shot. save_to = directory'),
      if_changed: z.boolean().optional().default(true).describe('Same pixels as the last screenshot of this tab: a note instead of the image. false = always send it'),
    },
    async ({ tab_id, save_to, presets, if_changed }) => {
      guardWrite(save_to);
      // Matrice responsive: viewport_resize + screenshot per preset erano 2N
      // turni; qui è una chiamata, e la finestra torna com'era.
      if (presets?.length) {
        const before = await send(MessageType.VIEWPORT_RESIZE, { read_only: true, tab_id });
        const content = [];
        const notes = [];
        try {
          for (const preset of presets) {
            const resized = await send(MessageType.VIEWPORT_RESIZE, { preset, tab_id });
            await new Promise((r) => setTimeout(r, 400));
            const shot = await send(MessageType.SCREENSHOT, { tab_id });
            if (!shot?.image) { notes.push(`${preset}: no image`); continue; }
            // presets ridimensiona la finestra, non emula un dispositivo: il
            // window manager può imporre una larghezza minima o ignorare la
            // richiesta. Un'immagine desktop etichettata «mobile» porta a
            // conclusioni sbagliate (2226 px su med-systems.it, 23/09/2026):
            // meglio nessuna immagine e una nota esplicita.
            const got = shot.viewport?.width;
            const want = PRESET_WIDTHS[preset];
            if (got && want && Math.abs(got - want) > Math.max(40, want * 0.15)) {
              const zoom = resized?.zoom && resized.zoom !== 1 ? `, page zoom ${Math.round(resized.zoom * 100)}%` : '';
              notes.push(`${preset}: NOT APPLIED — viewport stayed ${got}×${shot.viewport.height} CSS px (asked ~${want}${zoom}); `
                + 'the window manager refused the width. No capture saved: this would not be a ' + preset + ' rendering. '
                + 'Device emulation needs a headless browser.');
              continue;
            }
            if (save_to) {
              await mkdir(save_to, { recursive: true });
              const path = join(save_to, `${preset}.png`);
              await writeFile(path, Buffer.from(shot.image, 'base64'));
              notes.push(`${preset}: ${path} (viewport ${shot.viewport?.width}×${shot.viewport?.height})`);
            } else {
              content.push({ type: 'text', text: `${preset}: viewport ${shot.viewport?.width}×${shot.viewport?.height} CSS px` });
              content.push({ type: 'image', data: shot.image, mimeType: 'image/png' });
            }
          }
        } finally {
          const w = before?.window;
          if (w?.width && w?.height) await send(MessageType.VIEWPORT_RESIZE, { width: w.width, height: w.height, left: w.left, top: w.top, tab_id }).catch(() => {});
        }
        if (notes.length) content.unshift({ type: 'text', text: notes.join('\n') });
        return { content };
      }
      const data = await send(MessageType.SCREENSHOT, { tab_id });
      const b64 = data?.image ?? data?.data;
      if (save_to && b64) return savedSummary(save_to, Buffer.from(b64, 'base64'), { mimeType: 'image/png' });
      // data.image è base64 PNG. data.viewport (CSS px) è il sistema di
      // riferimento di element_screenshot.region: senza, il modello non sa
      // mappare ciò che vede sull'immagine ridotta a ≤1568px.
      if (data && data.image) {
        // Un'immagine costa ~1.500 token: rimandarla uguale (controllo dopo
        // un'azione che non ha cambiato nulla) è solo spesa.
        const key = refsKey(tab_id);
        const hash = createHash('sha1').update(data.image).digest('hex');
        const same = lastShot.get(key) === hash;
        lastShot.set(key, hash);
        if (same && if_changed !== false) {
          return { content: [{ type: 'text', text: 'unchanged: same pixels as the previous screenshot of this tab, image not sent again (if_changed:false forces it)' }] };
        }
        const content = [];
        if (data.viewport?.width) {
          content.push({ type: 'text', text: `viewport ${data.viewport.width}×${data.viewport.height} CSS px` });
        }
        content.push({ type: 'image', data: data.image, mimeType: 'image/png' });
        return { content };
      }
      return {
        content: [{
          type: 'text',
          text: jsonText(data),
        }],
      };
    }
  );

  // --- execute_js ---
  server.tool(
    'execute_js',
    'Run JavaScript in the page (MAIN world). Requires the extension\'s "Allow user scripts" toggle; errors explain setup if disabled. '
      + 'A promise is awaited up to timeout. A cut result stays valid JSON and says truncated; save_to writes the whole result to disk.',
    {
      code:       z.string().describe('JS evaluated in the page; the value of the last expression is returned'),
      tab_id:     tabId,
      frame_id:   frameId,
      max_length: z.number().optional().default(20000).describe('Max output chars'),
      timeout:    z.number().optional().describe('Max ms to wait for the result (default 30000); raise it for long async work'),
      save_to:    saveToField('the result (a string as is, anything else as JSON)'),
    },
    async ({ code, tab_id, frame_id, max_length, timeout, save_to }) => {
      guardWrite(save_to);
      const data = await send(MessageType.EXECUTE_JS, { code, tab_id, frame_id, ...(timeout ? { timeout } : {}) });
      if (save_to) {
        const value = data?.result;
        const isString = typeof value === 'string';
        return savedSummary(save_to, Buffer.from(isString ? value : JSON.stringify(value ?? null), 'utf8'), { format: isString ? 'text' : 'json' });
      }
      return { content: [{ type: 'text', text: jsResultText(data, max_length ?? DEFAULT_MAX_OUTPUT) }] };
    }
  );

  // --- click ---
  server.tool(
    'click',
    'Click an element by CSS selector or by a ref (n1, n2…) from get_interactives or navigate. A real pointer sequence: it can submit, '
      + 'open a dialog or navigate — use wait_after. Not idempotent; a native confirm() blocks the bridge: handle_dialogs first. '
      + 'Returns page_changed (url, title and DOM deltas: nodes, text, open, expanded, checked, dialogs, focus): the effect, without a screenshot; '
      + 'when the click opens or reveals something, the refs of the visible interactives follow, no get_interactives needed.',
    {
      selector: z.string().optional().describe('CSS selector; ">>>" pierces shadow DOM. Ignored when ref is given'),
      ref:      z.string().optional().describe('From get_interactives, e.g. "n3"'),
      force:    z.boolean().optional().default(false).describe('Click even if occluded'),
      button:   z.enum(['left', 'right']).optional().default('left').describe('right opens the page context menu instead of activating the element'),
      count:    z.number().optional().default(1).describe('2 emits dblclick after the two clicks, which is what selects a word or opens an editor'),
      trusted:  z.boolean().optional().default(false).describe('Real browser input (isTrusted) via chrome.debugger, main frame only: for widgets that ignore synthetic clicks'),
      wait_after: waitAfter,
      tab_id:   tabId,
      frame_id: frameId,
    },
    async ({ selector, ref, force, button, count, trusted, wait_after, tab_id, frame_id }) => {
      const { selector: target, frame_id: frame } = resolveTarget(selector, ref, tab_id, frame_id);
      const before = await tabSnapshot(tab_id);
      const data = await send(MessageType.CLICK, { selector: target, force, button: button ?? 'left', count: count ?? 1, ...(trusted && { trusted: true }), frame_id: frame, tab_id });
      // Niente attesa se il click non è andato a buon fine (es. elemento occluso)
      const waited = data?.occluded ? null : await applyWaitAfter(send, wait_after, tab_id, before?.url);
      // Senza wait_after l'impronta aspetta che il DOM si fermi: i framework
      // aggiornano dopo il click, non dentro; senza, "dopo" vedrebbe "prima".
      const settleAfter = (wait_after ?? 'none') === 'none';
      const changed = data?.occluded ? null : pageDelta(before, await (settleAfter ? settledSnapshot(tab_id) : tabSnapshot(tab_id)));
      const out = { ...data, ...(waited && { wait_after: waited }), ...(changed && { page_changed: changed }) };
      return {
        content: [{
          type: 'text',
          text: await withPreview(jsonText(out), changed, tab_id),
        }],
      };
    }
  );

  // --- type_text ---
  server.tool(
    'type_text',
    'Put text into an input, textarea or contenteditable, by selector or ref. Replaces the whole value through the '
      + 'native setter (React/Vue controlled inputs register it) and fires input and change. mode=keys emits '
      + 'keydown/input/keyup per character for autocomplete and masked fields: slower, use it only when mode=set leaves the field empty. '
      + 'Returns value_after; mismatch=true means the field did not keep the value: retry with mode=keys.',
    {
      selector: z.string().optional().describe('CSS selector; ">>>" pierces shadow DOM. Ignored when ref is given'),
      ref:      z.string().optional().describe('From get_interactives, e.g. "n3"'),
      text:     z.string().describe('Value to type; empty string clears the field'),
      mode:     z.enum(['set', 'keys', 'trusted']).optional().default('set').describe('set = assign value; keys = per-char events (autocomplete/masked); trusted = real input via chrome.debugger, main frame'),
      wait_after: waitAfter,
      tab_id:   tabId,
      frame_id: frameId,
    },
    async ({ selector, ref, text, mode, wait_after, tab_id, frame_id }) => {
      const { selector: target, frame_id: frame } = resolveTarget(selector, ref, tab_id, frame_id);
      const data = await send(MessageType.TYPE_TEXT, { selector: target, text, mode, tab_id, frame_id: frame });
      const waited = await applyWaitAfter(send, wait_after, tab_id);
      const out = waited ? { ...data, wait_after: waited } : data;
      const warn = data?.mismatch
        ? `\nthe field did not keep the value (value_after=${JSON.stringify(data.value_after ?? null)}): retry with mode=keys; if it still differs, the page rewrites it`
        : '';
      return {
        content: [{
          type: 'text',
          text: jsonText(out) + warn,
        }],
      };
    }
  );

  // --- read_page ---
  server.tool(
    'read_page',
    'Read the page as text (default), markdown, raw HTML, or accessibility tree. Read-only. markdown keeps headings, links and '
      + 'tables at a fraction of the HTML cost. Expensive on big pages: HTML on a large table costs tens of thousands of tokens '
      + 'for data you filter anyway — prefer extract_table/extract for repeated content, get_interactives for click targets.',
    {
      mode:       z.enum(['text', 'markdown', 'html', 'accessibility']).default('text').describe('text strips markup; markdown keeps headings/links/tables far cheaper than html; accessibility = a11y tree'),
      tab_id:     tabId,
      frame_id:   frameId,
      max_length: z.number().optional().default(50000).describe('Max output chars'),
      save_to:    saveToField('the page'),
    },
    async ({ mode, tab_id, frame_id, max_length, save_to }) => {
      guardWrite(save_to);
      const data = await send(MessageType.READ_PAGE, { mode, tab_id, frame_id });
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      if (save_to) return savedSummary(save_to, Buffer.from(text, 'utf8'), { mode: mode ?? 'text' });
      return {
        content: [{
          type: 'text',
          text: truncateText(text, max_length ?? 50000, 'max_length'),
        }],
      };
    }
  );

  // --- get_page_info ---
  server.tool(
    'get_page_info',
    'Page metadata: title, url, visibility, doctype, charset, meta tags, scripts, stylesheets, links and forms. visibility=hidden means '
      + 'the window is minimized, covered or in the background: the page does not render (screenshots fail) and its timers slow down. '
      + 'dev.server names a dev server (vite, webpack-dev-server, next, nuxt) and dev.overlay carries the compiler message when an error '
      + 'overlay is open: read it before treating the page as valid.',
    {
      tab_id: tabId,
      frame_id: frameId,
    },
    async ({ tab_id, frame_id }) => {
      const data = await send(MessageType.GET_PAGE_INFO, { tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: jsonText(data),
        }],
      };
    }
  );

  // --- get_storage ---
  server.tool(
    'get_storage',
    'Read localStorage, sessionStorage or cookies of the current origin (type=all for every one). Read-only. '
      + 'Cookies come with domain, path, expiry and the httpOnly/secure flags, so this also answers whether a '
      + 'session cookie is present — write them back with set_storage, or snapshot a logged-in state with session_fixture.',
    {
      type:   z.enum(['all', 'localStorage', 'sessionStorage', 'cookies']).default('all').describe('all returns the three together'),
      tab_id: tabId,
    },
    async ({ type, tab_id }) => {
      const data = await send(MessageType.GET_STORAGE, { type, tab_id });
      return {
        content: [{
          type: 'text',
          text: jsonText(data),
        }],
      };
    }
  );

  // --- query_dom ---
  server.tool(
    'query_dom',
    'Query DOM elements by CSS selector, returning structure, attributes, bounding rect, and computed styles.',
    {
      selector: z.string().describe('CSS selector; ">>>" pierces shadow DOM. Matches all, not just the first'),
      properties: z.array(z.string()).optional().describe('Computed styles to include, e.g. ["color"]'),
      limit: z.number().optional().default(50).describe('Max elements returned, from the top of the match list'),
      tab_id: tabId,
      frame_id: frameId,
    },
    async ({ selector, properties, limit, tab_id, frame_id }) => {
      const data = await send(MessageType.QUERY_DOM, { selector, properties, limit, tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: jsonText(data),
        }],
      };
    }
  );

  // --- get_css_styles ---
  server.tool(
    'get_css_styles',
    'Why an element looks the way it does: for each CSS property the winning declaration — selector, stylesheet, '
      + 'rule position, !important, @layer, @media — and the ones it overrides, like the Styles panel of DevTools; '
      + 'query_dom gives the computed value, this gives who set it. Read-only, from the CSSOM: stylesheets of '
      + 'another origin without CORS are opaque and listed by href; user-agent styles, @container and @scope rules '
      + 'are not evaluated. properties narrows the output.',
    {
      selector: z.string().describe('CSS selector; ">>>" pierces shadow DOM. Only the first match is inspected'),
      properties: z.array(z.string()).optional().describe('Only these, e.g. ["margin-top","--brand"]; margin covers its longhands. Omitted = every property a matching rule sets'),
      include_inherited: z.boolean().optional().default(false).describe('Also inherited properties (color, font-*, custom properties) with the ancestor that sets them'),
      tab_id: tabId,
      frame_id: frameId,
    },
    async ({ selector, properties, include_inherited, tab_id, frame_id }) => {
      const data = await send(MessageType.GET_CSS_STYLES, { selector, properties, include_inherited, tab_id, frame_id });
      return { content: [{ type: 'text', text: jsonText(data, DEFAULT_MAX_OUTPUT, 'properties') }] };
    }
  );

  // --- modify_dom ---
  server.tool(
    'modify_dom',
    'Change an element in the live DOM: setAttribute, removeAttribute, addClass, removeClass, setStyle, '
      + 'setTextContent. Nothing is persisted — the next reload restores the page as the server sends it. '
      + 'For styling many elements at once inject_css is one call instead of N.',
    {
      selector: z.string().describe('CSS selector; ">>>" pierces shadow DOM. Only the first match is changed'),
      action: z.enum(['setAttribute', 'removeAttribute', 'addClass', 'removeClass', 'setStyle', 'setTextContent']).describe('setStyle takes a CSS declaration in value; addClass/removeClass take className'),
      name: z.string().optional().describe('Attribute name'),
      value: z.string().optional().describe('Attribute value, style declaration, or text, per action'),
      className: z.string().optional().describe('Class to add or remove (addClass/removeClass)'),
      tab_id: tabId,
      frame_id: frameId,
    },
    async ({ selector, action, name, value, className, tab_id, frame_id }) => {
      const data = await send(MessageType.MODIFY_DOM, { selector, action, name, value, className, tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: jsonText(data),
        }],
      };
    }
  );

  // --- inject_css ---
  server.tool(
    'inject_css',
    'Inject a CSS rule into the page. Stays until the next navigation or reload, and re-injecting the same id '
      + 'replaces it rather than stacking. Affects only what is rendered — the stylesheet of the site is untouched.',
    {
      css: z.string().describe('One or more CSS rules, as they would appear in a stylesheet'),
      tab_id: tabId,
    },
    async ({ css, tab_id }) => {
      const data = await send(MessageType.INJECT_CSS, { css, tab_id });
      return {
        content: [{
          type: 'text',
          text: jsonText(data),
        }],
      };
    }
  );

  // --- read_console ---
  server.tool(
    'read_console',
    'Read console messages captured since page load, incl. uncaught errors and unhandled rejections.',
    {
      clear: z.boolean().optional().default(false).describe('Clear buffer after read'),
      level: z.enum(['all', 'log', 'warn', 'error', 'info', 'debug']).optional().default('all').describe('all merges every level in one chronological list'),
      limit: z.number().optional().default(50).describe('Most recent; buffer 1000'),
      format: z.enum(['lines', 'json']).optional().default('lines').describe('lines is compact; json keeps timestamps and stack traces'),
      sourcemap: z.boolean().optional().default(false).describe('Resolve bundle.js:line:col frames to source files through their source maps'),
      since: z.string().optional().describe('cursor from the previous read: only newer entries, nothing deleted'),
      tab_id: tabId,
    },
    async ({ clear, level, limit, format, tab_id, sourcemap, since }) => {
      // limit va all'estensione: taglia in pagina e cancella (con clear) solo
      // ciò che ha restituito. Lo slice qui resta come fallback per estensioni
      // più vecchie che ignorano il parametro.
      const data = await send(MessageType.READ_CONSOLE, { clear, level, limit, tab_id, ...(since && { since }) });
      const cursorLine = data?.cursor ? `\ncursor=${data.cursor} (pass as since to get only newer entries)` : '';
      const all = data?.messages ?? [];
      if (sourcemap) for (const msg of all) msg.args = await Promise.all((msg.args ?? []).map((a) => sourceMaps.resolve(String(a))));
      const tail = all.slice(-(limit ?? 50));
      const total = data?.count ?? all.length;
      const note = data?.note;
      if ((format ?? 'lines') === 'json') {
        return { content: [{ type: 'text', text: jsonText({ total, shown: tail.length, ...(data?.cursor && { cursor: data.cursor }), ...(note ? { note } : {}), messages: tail }) }] };
      }
      let text = (note ? `note=${note}\n` : '') + consoleLines(tail, total);
      // Con clear le voci restituite sono già cancellate in pagina: tagliare il
      // fondo del testo le perdeva senza mostrarle. Si accorcia ogni voce,
      // così compaiono tutte.
      if (clear && text.length > DEFAULT_MAX_OUTPUT && tail.length) {
        const per = Math.max(200, Math.floor(DEFAULT_MAX_OUTPUT / tail.length) - 40);
        const short = tail.map((m) => ({ ...m, args: (m.args ?? []).map((a) => (String(a).length > per ? `${String(a).slice(0, per)}…[cut]` : a)) }));
        text = (note ? `note=${note}\n` : '') + consoleLines(short, total);
      }
      return {
        content: [{
          type: 'text',
          text: truncateText(text, DEFAULT_MAX_OUTPUT) + cursorLine,
        }],
      };
    }
  );

  // --- monitor_network ---
  server.tool(
    'monitor_network',
    'Monitor network requests. source=page: XHR/fetch hook (installed on first call); source=browser: all requests incl. static assets; source=websocket: connections and messages. format=har exports HAR 1.2.',
    {
      clear: z.boolean().optional().default(false).describe('Clear buffer after read'),
      source: z.enum(['page', 'browser', 'websocket']).optional().default('page').describe('page: XHR/fetch only; browser: static assets too; websocket: connections and messages'),
      format: z.enum(['lines', 'json', 'har']).optional().default('lines').describe('har exports HAR 1.2 for external tooling'),
      limit: z.number().optional().default(100).describe('Most recent; buffer 1000'),
      since: z.string().optional().describe('cursor from the previous read: only newer entries, nothing deleted'),
      tab_id: tabId,
    },
    async ({ clear, source, format, limit, tab_id, since }) => {
      // limit va all'estensione (taglia in pagina, clear solo del restituito);
      // lo slice qui resta come fallback per estensioni non ancora aggiornate.
      if (source === 'websocket') {
        const ws = await send(MessageType.MONITOR_WEBSOCKET, { clear, tab_id });
        return { content: [{ type: 'text', text: jsonText(ws) }] };
      }
      const data = await send(MessageType.MONITOR_NETWORK, { clear, source, limit, tab_id, ...(since && { since }) });
      const { requests, count, note, ...rest } = data ?? {};
      const all = requests ?? [];
      const tail = all.slice(-(limit ?? 100));
      const total = count ?? all.length;
      const fmt = format ?? 'lines';
      if (fmt !== 'lines') {
        const out = fmt === 'har'
          ? toHar(tail)
          : { ...rest, total, shown: tail.length, ...(note ? { note } : {}), requests: tail };
        return { content: [{ type: 'text', text: jsonText(out) }] };
      }
      return {
        content: [{
          type: 'text',
          text: truncateText(
            (note ? `note=${note}\n` : '') + networkLines(tail, total),
            DEFAULT_MAX_OUTPUT,
          ) + (data?.cursor ? `\ncursor=${data.cursor} (pass as since to get only newer requests)` : ''),
        }],
      };
    }
  );

  // --- create_tab ---
  server.tool(
    'create_tab',
    'Open a new tab, optionally at a URL, and make it the implicit target of later commands in this session. '
      + 'Each call creates another tab: reuse a tab_id or navigate() to move an existing one instead of piling up tabs.',
    {
      url: z.string().optional().describe('URL to open (default: new tab page)'),
      active: z.boolean().optional().default(true).describe('false opens the tab in the background, leaving the current one focused'),
      new_window: z.boolean().optional().default(false).describe('Open in a fresh window instead of a tab; with left/top it lands on the chosen monitor'),
      left: z.number().optional().describe('Window x on the virtual desktop (new_window)'),
      top: z.number().optional().describe('Window y (new_window)'),
      width: z.number().optional().describe('Window width px (new_window)'),
      height: z.number().optional().describe('Window height px (new_window)'),
    },
    async ({ url, active, new_window, left, top, width, height }) => {
      const data = await send(MessageType.CREATE_TAB, { url, active, new_window: new_window === true || undefined, left, top, width, height });
      if (data?.id != null) { sessionTabId = data.id; ownedTabs.add(data.id); }
      return {
        content: [{
          type: 'text',
          text: jsonText(data),
        }],
      };
    }
  );

  // --- wait_for ---
  server.tool(
    'wait_for',
    'Block until a condition holds: element, text, function (JS expression; needs the "Allow user scripts" toggle), '
      + 'navigation (mode=spa for client-side routes), network_idle. Polls until timeout (10s element/function, 15s the rest) then '
      + '**returns `found: false` with a reason instead of raising**: check it, or a failed wait reads as success. Read-only.',
    {
      condition: z.enum(['element', 'text', 'function', 'navigation', 'network_idle']).describe('element and text need selector or text; function needs expression'),
      selector: z.string().optional().describe('condition=element; with condition=text it narrows the search to that subtree'),
      text: z.string().optional().describe('Literal text to wait for (condition=text), matched case-insensitively'),
      expression: z.string().optional().describe('JS expression (condition=function)'),
      visible: z.boolean().optional().default(false).describe('Element must also be visible'),
      mode: z.enum(['load', 'spa']).optional().default('load').describe('spa = pushState/popstate/hashchange'),
      idle_ms: z.number().optional().default(500).describe('Quiet period ms (network_idle)'),
      timeout: z.number().optional().describe('Max ms (default 10000; 15000 navigation/network_idle)'),
      interval: z.number().optional().describe('Poll ms, min 50'),
      tab_id: tabId,
      frame_id: frameId,
    },
    async ({ condition, selector, text, expression, visible, mode, idle_ms, timeout, interval, tab_id, frame_id }) => {
      let data;
      if (condition === 'element') {
        data = await send(MessageType.WAIT_FOR_ELEMENT, {
          selector, timeout: timeout ?? 10000, interval: interval ?? 200, visible: visible ?? false, tab_id, frame_id,
        });
      } else if (condition === 'text') {
        data = await send(MessageType.WAIT_FOR_TEXT, {
          text, selector, timeout: timeout ?? 10000, interval: interval ?? 200, tab_id, frame_id,
        });
      } else if (condition === 'function') {
        if (noJs) throw new Error('wait_for condition=function evaluates JavaScript, which is disabled (CHROME_BRIDGE_NO_JS): use condition=element or text');
        data = await send(MessageType.WAIT_FOR_FUNCTION, {
          expression, timeout: timeout ?? 10000, polling_ms: interval ?? 100, tab_id, frame_id,
        });
      } else if (condition === 'navigation') {
        data = await send(MessageType.WAIT_FOR_NAVIGATION, {
          timeout: timeout ?? 15000, mode: mode ?? 'load', tab_id,
        });
      } else {
        data = await send(MessageType.WAIT_FOR_NETWORK_IDLE, {
          idle_ms: idle_ms ?? 500, timeout: timeout ?? 15000, tab_id,
        });
      }
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- scroll ---
  server.tool(
    'scroll',
    'Scroll. action=to: once to element/coordinates; action=until: repeatedly until element visible, network idle, or no new content (infinite scroll).',
    {
      action: z.enum(['to', 'until']).optional().default('to').describe('to jumps to a position or element; until scrolls repeatedly to load more'),
      selector: z.string().optional().describe('Target (to) or stop element (until=element)'),
      x: z.number().optional().describe('Absolute horizontal position in px (action=to, without selector)'),
      y: z.number().optional().describe('Absolute vertical position in px (action=to, without selector)'),
      behavior: z.enum(['smooth', 'instant', 'auto']).optional().default('auto').describe('instant avoids waiting for smooth-scroll animations'),
      offset_y: z.number().optional().default(0).describe('px offset for fixed headers (to)'),
      until: z.enum(['element', 'network_idle', 'no_new_content']).optional().default('no_new_content').describe('no_new_content stops when the page height stops growing'),
      max_scrolls: z.number().optional().default(20).describe('Cap on scroll steps, so an infinite feed terminates'),
      step_px: z.number().optional().describe('px per step, default viewport height'),
      settle_ms: z.number().optional().default(400).describe('Pause ms after each step'),
      container: z.string().optional().describe('until: selector that scrolls; default the document, or the largest scrollable element if the document does not scroll'),
      tab_id: tabId,
      frame_id: frameId,
    },
    async ({ action, selector, x, y, behavior, offset_y, until, max_scrolls, step_px, settle_ms, container, tab_id, frame_id }) => {
      const data = (action ?? 'to') === 'until'
        ? await send(MessageType.SCROLL_UNTIL, { until, selector, container, max_scrolls, step_px, settle_ms, tab_id })
        : await send(MessageType.SCROLL_TO, { selector, x, y, behavior, offset_y, tab_id, frame_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- set_storage ---
  server.tool(
    'set_storage',
    'Write, delete or clear a localStorage/sessionStorage key, or a cookie with its path, domain and expiry. '
      + 'action=clear wipes every entry of that type for the origin and cannot be undone — on a site the user is '
      + 'logged into, clearing cookies logs them out. Read the current values first with get_storage.',
    {
      type: z.enum(['localStorage', 'sessionStorage', 'cookie']).describe('cookie writes a real cookie, not a storage key'),
      action: z.enum(['set', 'delete', 'clear']).describe('clear ignores key and wipes every entry of that type'),
      key: z.string().optional().describe('Required for set/delete'),
      value: z.string().optional().describe('Required for action=set'),
      path: z.string().optional().describe('Cookie path (default /)'),
      domain: z.string().optional().describe('Cookie domain'),
      expires: z.string().optional().describe('UTC date string (cookie)'),
      secure: z.boolean().optional().describe('Cookie sent over HTTPS only'),
      sameSite: z.enum(['Strict', 'Lax', 'None']).optional().describe('None requires secure=true'),
      http_only: z.boolean().optional().describe('Cookie hidden from page JS'),
      tab_id: tabId,
    },
    async ({ type, action, key, value, path, domain, expires, secure, sameSite, http_only, tab_id }) => {
      const data = await send(MessageType.SET_STORAGE, { type, action, key, value, path, domain, expires, secure, sameSite, http_only, tab_id });
      return {
        content: [{
          type: 'text',
          text: jsonText(data),
        }],
      };
    }
  );

  // --- fill_form ---
  server.tool(
    'fill_form',
    'Batch fill form fields with React-compatible events. Handles input, select, checkbox, radio, and textarea. '
    + 'Fields and submit take a CSS selector or a ref (n1, n2…) from navigate/get_interactives. '
    + 'With submit_selector it also submits, so a repeated call submits twice — not safe to retry blindly; '
    + 'after a submit, after_submit carries url, title and the text the page gained (the confirmation or the errors). '
    + 'Each field reports value_after and mismatch; page_changed carries the DOM delta, and the refs of what appeared.',
    {
      fields: z.array(z.object({
        selector: z.string().optional().describe('CSS selector; ignored when ref is given'),
        ref: z.string().optional().describe('From navigate or get_interactives, e.g. "n3"'),
        value: z.string().optional().describe('Text, option value or label; for checkbox/radio "true"/"false"'),
        checked: z.boolean().optional().describe('Checkbox/radio instead of value: true checks, false unchecks'),
      })).describe('{selector or ref, value or checked} per field'),
      submit_selector: z.string().optional().describe('Submit button to click after filling'),
      submit_ref: z.string().optional().describe('Submit button as a ref, instead of submit_selector'),
      wait_after: waitAfter,
      tab_id: tabId,
      frame_id: frameId,
    },
    async ({ fields, submit_selector, submit_ref, wait_after, tab_id, frame_id }) => {
      // I ref che navigate e get_interactives danno valevano per click,
      // type_text e hover ma non qui: il modello li passava comunque e
      // perdeva un turno sull'errore di validazione. Il ref vince sul
      // selettore, come negli altri tool.
      // checked: il modello lo scriveva per le checkbox e lo schema, che
      // voleva solo value, lo rifiutava (un turno, benchmark del 27/09/2026).
      // L'estensione capisce "true"/"false": la traduzione resta qui.
      // Campi indicati per ref: il frame viene dai ref, e devono stare tutti nello stesso.
      const refFrames = new Set(fields.filter((f) => f.ref).map((f) => resolveTarget(undefined, f.ref, tab_id, frame_id).frame_id ?? 0));
      if (refFrames.size > 1) throw new Error(`fill_form: the refs come from frames ${[...refFrames].join(', ')}; one call fills one frame`);
      if (frame_id == null && refFrames.size === 1) { const [f0] = refFrames; if (f0) frame_id = f0; }
      const resolved = fields.map((f) => {
        const { selector } = resolveTarget(f.ref ? undefined : f.selector, f.ref, tab_id, frame_id);
        const value = f.value ?? (typeof f.checked === 'boolean' ? String(f.checked) : undefined);
        if (value === undefined) throw new Error(`fill_form: field ${f.ref ?? f.selector} needs value or checked`);
        return { selector, value };
      });
      const submitSel = submit_ref ? resolveTarget(undefined, submit_ref, tab_id, frame_id).selector : submit_selector;
      const [before, textBefore] = await Promise.all([tabSnapshot(tab_id), submitSel ? pageText(tab_id, frame_id) : null]);
      const data = await send(MessageType.FILL_FORM, { fields: resolved, submit_selector: submitSel, tab_id, frame_id });
      const waited = await applyWaitAfter(send, wait_after, tab_id, before?.url);
      const after = await tabSnapshot(tab_id);
      const changed = pageDelta(before, after);
      // Dopo un invio il modello vuole sapere com'è andata: prima spendeva 1-3
      // turni fra find_text, extract e read_page per leggere la conferma.
      // submitted:false (campo fallito o pulsante assente): niente attesa di 2 s
      // per una conferma che non arriverà.
      const afterSubmit = submitSel && textBefore != null && data?.submitted !== false
        ? await submitOutcome(tab_id, frame_id, textBefore, after)
        : null;
      const out = {
        ...data,
        ...(waited && { wait_after: waited }),
        ...(changed && { page_changed: changed }),
        ...(afterSubmit && { after_submit: afterSubmit }),
      };
      // I campi che non hanno tenuto il valore in testa, in chiaro: sono la
      // riga che il modello deve leggere prima del JSON.
      const mism = (data?.fields ?? []).filter((f) => f && f.mismatch);
      const failedFields = (data?.fields ?? []).filter((f) => f && f.success === false);
      const head = [
        ...(submitSel && data?.submitted === false ? [`NOT SUBMITTED: ${data.reason ?? 'unknown reason'}`] : []),
        ...failedFields.map((f) => `failed: ${f.selector} (${f.error})`),
        ...mism.map((f) => `mismatch: ${f.selector} (${'checked_after' in f ? `checked_after=${f.checked_after}` : `value_after=${JSON.stringify(f.value_after ?? null)}`})`),
      ].map((l) => l + '\n').join('');
      return {
        content: [{
          type: 'text',
          text: await withPreview(head + jsonText(out), changed, tab_id),
        }],
      };
    }
  );

  // --- viewport_resize ---
  server.tool(
    'viewport_resize',
    'Resize the Chrome **window** to a preset (mobile 375x812, tablet 768x1024, desktop 1440x900) or explicit dimensions; '
      + 'the viewport is smaller by the browser chrome, action=get reports the real one. width/height override half a preset. '
      + 'A maximized window on ChromeOS ignores the request.',
    {
      action: z.enum(['set', 'get']).optional().default('set').describe('get reports the current viewport without resizing anything'),
      preset: z.enum(['mobile', 'tablet', 'desktop']).optional().describe('375x812, 768x1024, 1440x900'),
      left: z.number().optional().describe('Window x on the virtual desktop; on multi-monitor this is what picks the screen'),
      top: z.number().optional().describe('Window y on the virtual desktop'),
      state: z.enum(['normal', 'maximized', 'fullscreen', 'minimized']).optional()
        .describe('Applied before bounds: a maximized window accepts left/top/width/height and ignores them'),
      width: z.number().optional().describe('Overrides preset'),
      height: z.number().optional().describe('Overrides preset'),
      zoom: z.number().optional().describe('Page zoom for this origin, 1 = 100%; applied after the resize'),
      tab_id: tabId,
    },
    async ({ action, preset, width, height, left, top, state, tab_id , zoom}) => {
      const data = await send(MessageType.VIEWPORT_RESIZE, { preset, width, height, left, top, state, read_only: (action ?? 'set') === 'get', tab_id });
      // set_zoom era un tool a sé, a zero usi: lo zoom è una dimensione del viewport come le altre
      if (zoom != null) data.zoom = await send(MessageType.SET_ZOOM, { factor: zoom, reset: zoom === 1, tab_id });
      return {
        content: [{
          type: 'text',
          text: jsonText(data),
        }],
      };
    }
  );

  // --- element_screenshot ---
  server.tool(
    'element_screenshot',
    'Screenshot cropped to one element or to a viewport region (PNG), optionally enlarged. Read-only. '
      + 'The cheapest image in the set, because it carries only the box you asked for — and with scale the way '
      + 'to read fine print: crop the box, zoom it, verify.',
    {
      selector: z.string().optional().describe('CSS selector; ">>>" pierces shadow DOM. The element is scrolled into view first'),
      region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional()
        .describe('Box in viewport CSS px (the rect frame of get_interactives/query_dom), instead of selector'),
      scale: z.number().min(1).max(4).optional().default(1).describe('Enlargement of the crop, 1-4; output still capped at 1568px'),
      tab_id: tabId,
    },
    async ({ selector, region, scale, tab_id }) => {
      if (!selector && !region) throw new Error('Provide selector or region');
      const data = await send(MessageType.ELEMENT_SCREENSHOT, { selector, region, scale, tab_id });
      if (data && data.image) {
        return { content: [{ type: 'image', data: data.image, mimeType: 'image/png' }] };
      }
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- full_page_screenshot ---
  server.tool(
    'full_page_screenshot',
    'Full-page capture by scrolling: stitched segments of ~2 viewports (≤1568px), or one image per viewport with stitch=false. '
      + 'Expensive: ~2.7k image tokens per segment, only max_segments returned, the rest via segment_offset. '
      + 'Reading the text you need is cheaper by an order of magnitude — prefer read_page, extract or find_text unless layout is the question.',
    {
      max_scrolls: z.number().optional().default(20).describe('Cap on scroll steps: a taller page is captured only up to here'),
      delay: z.number().optional().default(500).describe('ms between captures (min 500, Chrome quota)'),
      stitch: z.boolean().optional().default(true).describe('false = one image per viewport'),
      max_segments: z.number().optional().default(3).describe('Images returned from the top (≈2.7k image tokens each); segment_offset for the rest'),
      segment_offset: z.number().optional().default(0).describe('Skip the first N segments'),
      tab_id: tabId,
    },
    async ({ max_scrolls, delay, stitch, max_segments, segment_offset, tab_id }) => {
      const data = await send(MessageType.FULL_PAGE_SCREENSHOT, { max_scrolls, delay, stitch, tab_id });
      if (data && data.images) {
        // DEFAULT_MAX_OUTPUT protegge solo il testo: senza questo cap una sola
        // chiamata su una pagina lunga restituiva 10 immagini (~4 MB base64,
        // ~27k token) ed era l'unico output del set capace di saturare il contesto.
        const off = Math.max(0, segment_offset ?? 0);
        const cap = Math.max(1, max_segments ?? 3);
        const slice = data.images.slice(off, off + cap);
        const more = data.images.length - (off + slice.length);
        const note = `Full page: ${data.totalCaptures} captures, ${data.images.length} segments (top→bottom), scrollHeight=${data.scrollHeight}`
          + `, showing ${off + 1}-${off + slice.length}`
          + (more > 0 ? ` — ${more} more: call with segment_offset=${off + slice.length}` : '')
          + (data.truncated ? ' (page continues beyond captured area — raise max_scrolls to capture more)' : '');
        return {
          content: [
            { type: 'text', text: note },
            ...slice.map((img) => ({ type: 'image', data: img, mimeType: 'image/png' })),
          ],
        };
      }
      // Retrocompatibilità: extension non ancora ricaricata → singola immagine stitched
      if (data && data.image) {
        const note = `Full page: ${data.totalCaptures} captures stitched, scrollHeight=${data.scrollHeight}${data.truncated ? ' (truncated at 16384px canvas limit)' : ''}`;
        return { content: [{ type: 'text', text: note }, { type: 'image', data: data.image, mimeType: 'image/png' }] };
      }
      const content = [{ type: 'text', text: `Full page screenshot: ${data.captures?.length || 0} captures, scrollHeight=${data.scrollHeight}, viewportHeight=${data.viewportHeight}` }];
      for (const img of data.captures || []) {
        content.push({ type: 'image', data: img, mimeType: 'image/png' });
      }
      return { content };
    }
  );

  // --- measure_spacing ---
  server.tool(
    'measure_spacing',
    'Measure the gap, overlap and distance in CSS pixels between two elements, with their margins and paddings. '
      + 'Read-only. Values come from the current layout, so zoom and viewport size change them: viewport_resize({zoom:1}) and a '
      + 'fixed viewport_resize make results comparable across runs.',
    {
      selector1: z.string().describe('First element; distances are measured from its box'),
      selector2: z.string().describe('Second element; ">>>" pierces shadow DOM'),
      tab_id: tabId,
    },
    async ({ selector1, selector2, tab_id }) => {
      const data = await send(MessageType.MEASURE_SPACING, { selector1, selector2, tab_id });
      return {
        content: [{
          type: 'text',
          text: jsonText(data),
        }],
      };
    }
  );

  // --- watch_dom ---
  server.tool(
    'watch_dom',
    'Watch DOM mutations (MutationObserver). First call installs the watcher; later calls read accumulated mutations.',
    {
      selector: z.string().optional().default('body').describe('Subtree to observe; ">>>" pierces shadow DOM'),
      attributes: z.boolean().optional().default(true).describe('Report attribute changes'),
      childList: z.boolean().optional().default(true).describe('Report added and removed children'),
      characterData: z.boolean().optional().default(false).describe('Report text content changes'),
      subtree: z.boolean().optional().default(true).describe('Observe descendants too, not just the matched node'),
      clear: z.boolean().optional().default(false).describe('Clear buffer after read'),
      stop: z.boolean().optional().default(false).describe('Disconnect observer'),
      limit: z.number().optional().default(100).describe('Most recent mutations; buffer 1000'),
      tab_id: tabId,
    },
    async ({ selector, attributes, childList, characterData, subtree, clear, stop, limit, tab_id }) => {
      const data = await send(MessageType.WATCH_DOM, { selector, attributes, childList, characterData, subtree, clear, stop, limit, tab_id });
      return {
        content: [{
          type: 'text',
          text: jsonText(data),
        }],
      };
    }
  );

  // --- emulate_media ---
  server.tool(
    'emulate_media',
    'Make the page believe it runs elsewhere, until reset or reload: prefers-color-scheme, prefers-reduced-motion, print mode, '
      + 'navigator.userAgent/platform. user_agent changes only what page JS reads — the request header is network_rules modify_header. '
      + 'via "page" (default for these) only patches matchMedia and, for reduce, zeroes every animation: the site\'s own @media rules do not apply. '
      + 'via "debugger" emulates like DevTools, so the site\'s @media (prefers-reduced-motion) rules really apply — use it to check reduced motion with animations — '
      + 'and adds contrast, CPU throttling, network profiles, device viewport with DPR, touch (these imply via debugger). '
      + 'via debugger keeps Chrome\'s "started debugging this browser" bar until reset: true; in launch mode nobody sees it. '
      + 'Pair with viewport_resize to emulate a device in page mode.',
    {
      colorScheme: z.enum(['dark', 'light', 'no-preference']).optional().describe('Value reported to prefers-color-scheme queries'),
      reducedMotion: z.enum(['reduce', 'no-preference']).optional().describe('Value reported to prefers-reduced-motion queries'),
      printMode: z.boolean().optional().default(false).describe('Make print media queries match, without opening a print dialog'),
      user_agent: z.string().optional().describe('Overrides navigator.userAgent and appVersion in the page (not the HTTP header)'),
      via: z.enum(['page', 'debugger']).optional().describe('page: script shim, no browser bar; debugger: real emulation (default when a debugger-only option is set)'),
      contrast: z.enum(['more', 'less', 'no-preference']).optional().describe('Value reported to prefers-contrast queries (debugger)'),
      cpu_throttle: z.number().optional().describe('CPU slowdown factor, e.g. 4 for a mid-range phone; 1 turns it off (debugger)'),
      network: z.enum(['offline', '3g', 'slow-4g', 'fast-4g', 'none']).optional().describe('DevTools network profile; none turns it off (debugger)'),
      device: z.object({
        width: z.number().describe('Viewport width in CSS px'),
        height: z.number().describe('Viewport height in CSS px'),
        dpr: z.number().optional().default(1).describe('Device pixel ratio'),
        mobile: z.boolean().optional().default(false).describe('Mobile viewport: meta viewport and overlay scrollbars apply'),
      }).optional().describe('Device metrics override (debugger)'),
      touch: z.boolean().optional().describe('Emulate a touch screen (debugger)'),
      reset: z.boolean().optional().default(false).describe('Remove all emulations and detach the debugger'),
      tab_id: tabId,
    },
    async ({ colorScheme, reducedMotion, printMode, user_agent, via, contrast, cpu_throttle, network, device, touch, reset, tab_id }) => {
      const data = await send(MessageType.EMULATE_MEDIA, { colorScheme, reducedMotion, printMode, user_agent, via, contrast, cpu_throttle, network, device, touch, reset, tab_id });
      return {
        content: [{
          type: 'text',
          text: jsonText(data),
        }],
      };
    }
  );

  // --- animations, frames (gruppo perf) ---
  // Finestra di registrazione nella pagina con un'azione eseguita dai tool di
  // sempre: un :hover CSS o un listener di click scattano come con hover e
  // click, mentre l'osservatore è già in ascolto.
  const motionAction = z.object({
    type: z.enum(['click', 'hover', 'scroll', 'press_key']).describe('What to do once recording has started'),
    selector: z.string().optional().describe('CSS selector of the element to act on (scroll: element to scroll into view)'),
    ref: z.string().optional().describe('From get_interactives, e.g. "n3"'),
    key: z.string().optional().describe('press_key: e.g. "Enter", "Escape", "ArrowDown"'),
    y: z.number().optional().describe('scroll without selector: absolute vertical position in px'),
    trusted: z.boolean().optional().describe('Real browser input via chrome.debugger; default true for hover (CSS :hover needs it), false otherwise'),
  }).optional().describe('Action run right after recording starts');
  const MOTION_MAX_MS = 30000;

  async function runMotionAction(action, tab_id, frame_id) {
    const t = action.selector || action.ref ? resolveTarget(action.selector, action.ref, tab_id, frame_id) : { selector: undefined, frame_id };
    // Un hover sintetico non accende il :hover del CSS: per misurare le sue
    // transizioni serve il puntatore vero, quindi qui è il default.
    const trusted = (action.trusted ?? action.type === 'hover') ? { trusted: true } : {};
    if (action.type === 'click') return send(MessageType.CLICK, { selector: t.selector, button: 'left', count: 1, ...trusted, frame_id: t.frame_id, tab_id });
    if (action.type === 'hover') return send(MessageType.HOVER, { selector: t.selector, ...trusted, frame_id: t.frame_id, tab_id });
    if (action.type === 'press_key') return send(MessageType.PRESS_KEY, { key: action.key ?? 'Enter', selector: t.selector, ...trusted, frame_id: t.frame_id, tab_id });
    return send(MessageType.SCROLL_TO, { selector: t.selector, y: action.y, behavior: 'smooth', tab_id, frame_id: t.frame_id });
  }

  async function motionWindow({ duration_ms, action, scope, limit, threshold_ms, tab_id, frame_id }) {
    const ms = Math.min(Math.max(duration_ms, 100), MOTION_MAX_MS);
    const t0 = Date.now();
    await send(MessageType.MOTION, { op: 'start', scope, tab_id, frame_id });
    let actionError = null;
    try {
      if (action) await runMotionAction(action, tab_id, frame_id);
    } catch (err) {
      actionError = err.message;
    }
    // Dopo l'azione resta almeno un po' di finestra: una transizione parte al
    // fotogramma successivo al click.
    const rest = Math.max(ms - (Date.now() - t0), action ? 300 : 0);
    await new Promise((r) => setTimeout(r, rest));
    const data = await send(MessageType.MOTION, { op: 'stop', limit, threshold_ms, tab_id, frame_id });
    if (actionError) data.action_error = actionError;
    return data;
  }

  server.tool(
    'animations',
    'List the page animations: CSS animations, transitions, Web Animations and View Transitions, each with selector and ref, '
      + 'animated properties, duration, delay, easing (linear() curves included), iterations, play state, timeline (document, scroll, view). '
      + 'composited_estimate guesses whether only transform/opacity/filter move (an estimate, not the compositor\'s answer); fade_only marks '
      + 'opacity-only fades, what prefers-reduced-motion should leave. Without duration_ms: what runs now. With duration_ms: records every '
      + 'animation that starts in the window, optionally after an action (hover, click, scroll, key), since a 150 ms transition is over '
      + 'before a second call. Refuses on a hidden page. Pair with emulate_media reducedMotion to check the reduced version.',
    {
      scope: z.string().optional().describe('CSS selector: only animations on this element or inside it'),
      duration_ms: z.number().optional().describe('Record for this many ms (max 30000) instead of a snapshot'),
      action: motionAction,
      limit: z.number().optional().default(50).describe('Max animations listed; the summary counts all'),
      tab_id: tabId,
      frame_id: frameId,
    },
    async ({ scope, duration_ms, action, limit, tab_id, frame_id }) => {
      let data;
      if (duration_ms == null && !action) {
        data = await send(MessageType.MOTION, { op: 'snapshot', scope, limit, tab_id, frame_id });
      } else {
        const rec = await motionWindow({ duration_ms: duration_ms ?? 1000, action, scope, limit: Math.ceil(limit / 3), tab_id, frame_id });
        data = {
          window_ms: rec.window_ms,
          prefers_reduced_motion: rec.prefers_reduced_motion,
          ...(rec.page_hidden_during && { page_hidden_during: true }),
          ...(rec.action_error && { action_error: rec.action_error }),
          summary: rec.animations.summary,
          animations: rec.animations.list,
          ...(rec.animations.truncated && { truncated: rec.animations.truncated }),
        };
      }
      assignRefs(tab_id, data.animations, frame_id);
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  server.tool(
    'frames',
    'Record the page for duration_ms and report how smooth it ran: main-thread frame rate and dropped frames, Long Animation Frames '
      + '(duration, blocking time, render and style/layout start, the scripts responsible), layout shifts with the elements that moved (CLS '
      + 'for the window only), and the slowest interaction (INP for the window, split into input delay, processing, presentation; needs trusted input, synthetic events have no interaction id). '
      + 'Optionally runs an action (click, hover, scroll, key) right after recording starts. Animations that started are counted too. '
      + 'Compositor-only animations can stay smooth while the main thread drops frames. Refuses on a hidden page: rAF and observers stop there.',
    {
      duration_ms: z.number().optional().default(3000).describe('Recording window in ms (max 30000)'),
      action: motionAction,
      threshold_ms: z.number().optional().default(50).describe('Long frames shorter than this are not listed'),
      limit: z.number().optional().default(10).describe('Max long frames listed; counts include all'),
      tab_id: tabId,
      frame_id: frameId,
    },
    async ({ duration_ms, action, threshold_ms, limit, tab_id, frame_id }) => {
      const rec = await motionWindow({ duration_ms, action, limit, threshold_ms, tab_id, frame_id });
      const { animations, ...rest } = rec;
      const data = { ...rest, animations: animations.summary };
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- perf_trace (gruppo perf) ---
  const captureStamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // Insight del pannello Performance, solo se chi installa ha aggiunto
  // @paulirish/trace_engine (peer opzionale: npm non lo installa da solo,
  // l'API è dichiarata instabile). Senza, restano le metriche di
  // trace-analysis.js.
  async function engineInsights(events) {
    let TE;
    try { TE = await import('@paulirish/trace_engine'); } catch { return null; }
    try {
      globalThis.DOMRect ??= class DOMRect { constructor(x = 0, y = 0, width = 0, height = 0) { Object.assign(this, { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height }); } };
      const model = TE.TraceModel.Model.createWithAllHandlers();
      await model.parse(events);
      // 0.0.65: parsedTrace(i).insights è una Map per navigazione; ogni
      // insight ha state pass/fail/informative e un titolo localizzato.
      const insights = model.parsedTrace(0)?.insights;
      const out = [];
      for (const set of insights?.values?.() ?? []) {
        for (const [name, ins] of Object.entries(set.model ?? {})) {
          if (!ins?.state || ins.state === 'pass') continue;
          const title = ins.strings?.title ?? ins.title;
          const savings = ins.metricSavings && Object.fromEntries(Object.entries(ins.metricSavings).filter(([, v]) => v).map(([k, v]) => [k, Math.round(v)]));
          out.push({ name, state: ins.state, ...(title && { title: String(title) }), ...(savings && Object.keys(savings).length && { savings_ms: savings }) });
        }
      }
      return out;
    } catch (err) {
      return [{ name: 'engine_error', state: 'error', title: err.message }];
    }
  }

  async function finishTrace(tab_id, save_to) {
    const path = guardWrite(save_to ?? join(CAPTURES_DIR, `trace-${captureStamp()}.json`));
    await send(MessageType.PERF_TRACE, { op: 'stop', tab_id, timeout: 40000 });
    const chunks = [];
    for (;;) {
      const c = await send(MessageType.PERF_TRACE, { op: 'read', tab_id });
      chunks.push(Buffer.from(c.data ?? '', c.base64 ? 'base64' : 'utf8'));
      if (c.eof) break;
    }
    const raw = Buffer.concat(chunks);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, raw);
    const json = JSON.parse(raw.toString('utf8'));
    const analysis = analyzeTrace(json);
    const insights = await engineInsights(traceEventsOf(json));
    return { saved: path, bytes: raw.length, ...analysis, ...(insights && { insights }) };
  }

  server.tool(
    'perf_trace',
    'Record a DevTools performance trace and return its conclusions, never the trace: LCP with its phases (TTFB, resource load delay and '
      + 'duration, render delay), FCP, CLS (session windows), INP, the document request, render-blocking resources, long tasks with the '
      + 'function responsible, long animation frames. The raw trace goes to a JSON file (path and size in the result) that DevTools > '
      + 'Performance can load. action record (default) = start, reload unless reload: false, optional action, wait duration_ms, stop. '
      + 'start/stop bracket anything else done meanwhile. Uses chrome.debugger: Chrome shows its debugging bar while tracing; in launch '
      + 'mode nobody sees it. Refuses on a hidden page.',
    {
      action: z.enum(['record', 'start', 'stop']).optional().default('record').describe('record does start → wait → stop in one call'),
      reload: z.boolean().optional().describe('Reload the page right after tracing starts (default true for record, false for start)'),
      duration_ms: z.number().optional().default(5000).describe('record: how long to trace, max 60000'),
      interaction: motionAction,
      save_to: saveToField('the trace JSON'),
      tab_id: tabId,
    },
    async ({ action, reload, duration_ms, interaction, save_to, tab_id }) => {
      if (action === 'stop') {
        return { content: [{ type: 'text', text: jsonText(await finishTrace(tab_id, save_to)) }] };
      }
      const doReload = reload ?? action === 'record';
      await send(MessageType.PERF_TRACE, { op: 'start', reload: doReload, tab_id });
      if (action === 'start') {
        return { content: [{ type: 'text', text: jsonText({ tracing: true, reloaded: doReload, next: 'perf_trace action: "stop"' }) }] };
      }
      const t0 = Date.now();
      let interactionError = null;
      try {
        if (interaction) {
          // Dopo un reload l'elemento esiste solo a pagina caricata.
          if (doReload) await send(MessageType.WAIT_FOR_NAVIGATION, { timeout: 15000, tab_id }).catch(() => {});
          await runMotionAction(interaction, tab_id);
        }
        await new Promise((r) => setTimeout(r, Math.max(0, Math.min(duration_ms, 60000) - (Date.now() - t0))));
      } catch (err) {
        interactionError = err.message;
      }
      try {
        const data = await finishTrace(tab_id, save_to);
        if (interactionError) data.interaction_error = interactionError;
        return { content: [{ type: 'text', text: jsonText(data) }] };
      } catch (err) {
        await send(MessageType.PERF_TRACE, { op: 'abort', tab_id }).catch(() => {});
        throw err;
      }
    }
  );

  // --- screencast (gruppo perf) ---
  // I fotogrammi passano dall'estensione al disco ogni 400 ms: in memoria
  // resta poco, e una registrazione lunga non pesa sul service worker.
  const casts = new Map();
  const CAST_DRAIN_MS = 400;
  const CAST_MAX_MS = 120000;

  async function castWrite(cast, frames) {
    for (const f of frames) {
      const file = `frame-${String(cast.frames.length + 1).padStart(5, '0')}.jpg`;
      await writeFile(join(cast.dir, file), Buffer.from(f.data, 'base64'));
      cast.frames.push({ file, t: f.t });
    }
  }

  async function castStart(tab_id, { quality, max_width }) {
    const key = refsKey(tab_id);
    if (casts.has(key)) throw new Error('A screencast is already running here: screencast action stop first');
    const dir = join(CAPTURES_DIR, `screencast-${captureStamp()}`);
    await mkdir(dir, { recursive: true });
    try {
      await send(MessageType.SCREENCAST, { op: 'start', quality, max_width, tab_id });
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
    const cast = { dir, frames: [], tab_id, started: Date.now(), busy: Promise.resolve() };
    cast.timer = setInterval(() => {
      cast.busy = cast.busy.then(async () => {
        const d = await send(MessageType.SCREENCAST, { op: 'drain', tab_id }).catch(() => null);
        if (d?.frames?.length) await castWrite(cast, d.frames);
        if (Date.now() - cast.started > CAST_MAX_MS) clearInterval(cast.timer);
      });
    }, CAST_DRAIN_MS);
    casts.set(key, cast);
  }

  async function castStop(tab_id, { format, fps, save_to }) {
    const key = refsKey(tab_id);
    const cast = casts.get(key);
    if (!cast) throw new Error('No screencast running here: screencast action start first');
    casts.delete(key);
    clearInterval(cast.timer);
    await cast.busy;
    const out = guardWrite(save_to ?? join(CAPTURES_DIR, `${basename(cast.dir)}.${format}`));
    const last = await send(MessageType.SCREENCAST, { op: 'stop', tab_id });
    await castWrite(cast, last.frames ?? []);
    const base = { frames: cast.frames.length, ...(last.dropped && { dropped: last.dropped }), duration_s: Math.round((Date.now() - cast.started) / 100) / 10 };
    if (!cast.frames.length) {
      await rm(cast.dir, { recursive: true, force: true });
      return { ...base, video: null, note: 'No frames: the page did not change, or the tab was not visible' };
    }
    await mkdir(dirname(out), { recursive: true });
    const v = await assembleVideo(cast.dir, cast.frames, Date.now() / 1000, out, { format, fps });
    if (!v.video) return { ...base, ...v };
    await rm(cast.dir, { recursive: true, force: true });
    return { ...base, video: out, bytes: (await stat(out)).size };
  }

  server.tool(
    'screencast',
    'Record the tab as a video (.mp4 or .webm) to watch an animation or interaction frame by frame; returns the file path and size, never '
      + 'the frames. action record (default) = start, optional interaction, wait duration_ms, stop. start/stop bracket anything else done '
      + 'meanwhile (max 120 s). Chrome sends a frame only when the page changes; the video keeps the real timing. Needs the tab active and '
      + 'its window visible, and ffmpeg on the server machine (without it: the JPEG folder and the ffmpeg command). Uses chrome.debugger: '
      + 'Chrome shows its debugging bar while recording; in launch mode nobody sees it.',
    {
      action: z.enum(['record', 'start', 'stop']).optional().default('record').describe('record does start → wait → stop in one call'),
      duration_ms: z.number().optional().default(5000).describe('record: how long to record, max 120000'),
      interaction: motionAction,
      format: z.enum(['mp4', 'webm']).optional().default('mp4').describe('Video container'),
      fps: z.number().optional().default(30).describe('Frame rate of the output video'),
      quality: z.number().optional().default(70).describe('JPEG quality of the captured frames, 0-100'),
      max_width: z.number().optional().default(1280).describe('Scale frames down to this width in px'),
      save_to: saveToField('the video'),
      tab_id: tabId,
    },
    async ({ action, duration_ms, interaction, format, fps, quality, max_width, save_to, tab_id }) => {
      if (action === 'stop') return { content: [{ type: 'text', text: jsonText(await castStop(tab_id, { format, fps, save_to })) }] };
      await castStart(tab_id, { quality, max_width });
      if (action === 'start') return { content: [{ type: 'text', text: jsonText({ recording: true, next: 'screencast action: "stop"' }) }] };
      const t0 = Date.now();
      let interactionError = null;
      try {
        if (interaction) await runMotionAction(interaction, tab_id);
      } catch (err) {
        interactionError = err.message;
      }
      await new Promise((r) => setTimeout(r, Math.max(0, Math.min(duration_ms, CAST_MAX_MS) - (Date.now() - t0))));
      const data = await castStop(tab_id, { format, fps, save_to });
      if (interactionError) data.interaction_error = interactionError;
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- lighthouse, heap_snapshot (gruppo perf, solo modalità launch) ---
  const LAUNCH_ONLY = 'only in launch mode (chrome-bridge --launch [--headless]): it needs the DevTools port of the dedicated browser, '
    + 'which the extension in your own Chrome cannot provide';
  const cdpPortOrThrow = async (tool) => {
    if (!options.cdpPort) throw new Error(`${tool} works ${LAUNCH_ONLY}.`);
    return options.cdpPort();
  };

  server.tool(
    'lighthouse',
    'Run a full Lighthouse audit (performance included, unlike chrome-devtools-mcp, plus accessibility, best practices, SEO) and return '
      + 'scores, the five lab metrics and the failing audits that weigh most; the full report goes to .report.json and .report.html files. '
      + `Works ${LAUNCH_ONLY}. Loads the URL in a new tab of that browser; takes 20-60 s; the first call downloads Lighthouse through npx.`,
    {
      url: z.string().optional().describe('Page to audit; omitted = the URL of the target tab'),
      categories: z.array(z.enum(['performance', 'accessibility', 'best-practices', 'seo'])).optional().describe('Subset of categories; omitted = all four'),
      form_factor: z.enum(['mobile', 'desktop']).optional().default('mobile').describe('mobile emulates a mid-range phone with slow 4G, as PageSpeed Insights does'),
      save_to: z.string().optional().describe('Absolute path without extension: the report is written to <path>.report.json and <path>.report.html'),
      tab_id: tabId,
    },
    async ({ url, categories, form_factor, save_to, tab_id }) => {
      const port = await cdpPortOrThrow('lighthouse');
      const target = url ?? (await send(MessageType.CDP_TARGET, { tab_id })).url;
      if (!/^https?:/i.test(target ?? '')) throw new Error(`Lighthouse needs an http(s) URL, got ${target}`);
      const base = guardWrite(save_to ?? join(CAPTURES_DIR, `lighthouse-${captureStamp()}`));
      await mkdir(dirname(base), { recursive: true });
      await runLighthouse(lighthouseArgs(target, port, base, { categories, formFactor: form_factor }));
      const lhr = JSON.parse(await readFile(`${base}.report.json`, 'utf8'));
      const data = { ...summarizeLighthouse(lhr), report: `${base}.report.html`, json: `${base}.report.json` };
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  server.tool(
    'heap_snapshot',
    'Take a JS heap snapshot of the tab (after a garbage collection) and summarize it: object count, total size, detached DOM nodes, the '
      + 'classes that take most memory. With compare_to (an earlier snapshot file): which classes grew, to find a leak — snapshot, repeat the '
      + 'suspect action a few times, snapshot again. The .heapsnapshot file opens in DevTools > Memory. '
      + `Works ${LAUNCH_ONLY}: Chrome refuses the HeapProfiler domain to extensions.`,
    {
      compare_to: z.string().optional().describe('Absolute path of an earlier .heapsnapshot to diff against'),
      top: z.number().optional().default(15).describe('Classes listed'),
      save_to: saveToField('the .heapsnapshot'),
      tab_id: tabId,
    },
    async ({ compare_to, top, save_to, tab_id }) => {
      const port = await cdpPortOrThrow('heap_snapshot');
      const before = compare_to ? summarizeHeap(JSON.parse(await readFile(await guardRead(compare_to), 'utf8')), { top }) : null;
      const { target_id } = await send(MessageType.CDP_TARGET, { tab_id });
      const path = guardWrite(save_to ?? join(CAPTURES_DIR, `heap-${captureStamp()}.heapsnapshot`));
      await mkdir(dirname(path), { recursive: true });
      const cdp = await cdpConnect(await targetWsUrl(port, target_id));
      let bytes;
      try {
        bytes = await takeHeapSnapshot(cdp, path);
      } finally {
        cdp.close();
      }
      const now = summarizeHeap(JSON.parse(await readFile(path, 'utf8')), { top });
      const { _all, ...summary } = now;
      const data = { saved: path, bytes, ...summary, ...(before && { compared_to: compare_to, diff: diffHeap(before, now, { top }) }) };
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- hover ---
  server.tool(
    'hover',
    'Hover over an element, by CSS selector or ref. Default: synthetic mouseenter/mouseover/mousemove, which fire JS hover handlers '
      + 'but not CSS :hover. trusted moves the real mouse pointer (chrome.debugger), so CSS :hover rules and their transitions apply.',
    {
      selector: z.string().optional().describe('CSS selector; ">>>" pierces shadow DOM'),
      ref: z.string().optional().describe('From get_interactives'),
      trusted: z.boolean().optional().default(false).describe('Real browser pointer via chrome.debugger, main frame only: needed for CSS :hover'),
      tab_id: tabId,
      frame_id: frameId,
    },
    async ({ selector, ref, trusted, tab_id, frame_id }) => {
      const t = resolveTarget(selector, ref, tab_id, frame_id);
      const data = await send(MessageType.HOVER, { selector: t.selector, ...(trusted && { trusted: true }), tab_id, frame_id: t.frame_id });
      return {
        content: [{
          type: 'text',
          text: jsonText(data),
        }],
      };
    }
  );

  // --- press_key ---
  server.tool(
    'press_key',
    'Send a key to the focused element (or to selector, focusing it first) as a real keydown/keypress/keyup '
      + 'sequence, so framework handlers fire. For typing a value use type_text; this is for Enter, Tab, Escape, '
      + 'arrows and shortcuts. Not idempotent: two calls send the key twice. '
      + 'Returns page_changed like click; when the key opens or reveals something, the refs of the visible interactives follow.',
    {
      key: z.string().describe('e.g. "Enter", "Escape", "Tab", "ArrowDown"'),
      selector: z.string().optional().describe('Target (default: activeElement)'),
      ctrl: z.boolean().optional().default(false).describe('Hold Control'),
      shift: z.boolean().optional().default(false).describe('Hold Shift'),
      alt: z.boolean().optional().default(false).describe('Hold Alt'),
      meta: z.boolean().optional().default(false).describe('Hold Meta (Command/Windows)'),
      trusted: z.boolean().optional().default(false).describe('Real browser key (isTrusted) via chrome.debugger, main frame only'),
      tab_id: tabId,
      frame_id: frameId,
    },
    async ({ key, selector, ctrl, shift, alt, meta, trusted, tab_id, frame_id }) => {
      // Come click: Enter invia, Escape chiude, ArrowDown apre un menu. Il
      // delta e i ref nuovi evitano il giro di get_interactives dopo.
      const before = await tabSnapshot(tab_id);
      const data = await send(MessageType.PRESS_KEY, { key, selector, ctrl, shift, alt, meta, ...(trusted && { trusted: true }), tab_id, frame_id });
      const changed = pageDelta(before, await settledSnapshot(tab_id));
      const out = { ...data, ...(changed && { page_changed: changed }) };
      return {
        content: [{
          type: 'text',
          text: await withPreview(jsonText(out), changed, tab_id),
        }],
      };
    }
  );

  // --- get_frames ---
  server.tool(
    'get_frames',
    'List frames (main + iframes) with frameId, parent, URL — for the frame_id parameter of DOM tools.',
    {
      tab_id: tabId,
    },
    async ({ tab_id }) => {
      const data = await send(MessageType.GET_FRAMES, { tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- tab_action ---
  server.tool(
    'tab_action',
    'Tab lifecycle: close, activate, reload, back, forward, discard, mute, duplicate, close_session (only tabs this session created). '
      + 'close drops unsaved work and cannot be undone — it may be the user\'s tab. reload drops injected CSS, emulations and hooks. '
      + 'duplicate works where create_tab is forbidden (chrome-untrusted://) and lands in the source window, app windows included. '
      + 'discard replaces the tab id.',
    {
      action: z.enum(['close', 'activate', 'reload', 'back', 'forward', 'discard', 'mute', 'unmute', 'duplicate', 'close_session']).describe('close cannot be undone; discard frees memory (reloads on focus); reload drops injected CSS and hooks'),
      bypass_cache: z.boolean().optional().default(false).describe('reload only'),
      tab_id: tabId,
    },
    async ({ action, bypass_cache, tab_id }) => {
      // close_session: solo le tab create da questa sessione, mai quelle dell'utente
      if (action === 'close_session') {
        const closed = [];
        for (const id of [...ownedTabs]) { try { await send(MessageType.TAB_ACTION, { action: 'close', tab_id: id }); closed.push(id); } catch { /* già chiusa */ } ownedTabs.delete(id); }
        if (sessionTabId != null && closed.includes(sessionTabId)) sessionTabId = null;
        return { content: [{ type: 'text', text: jsonText({ closed }) }] };
      }
      const data = await send(MessageType.TAB_ACTION, { action, bypass_cache, tab_id });
      if (action === 'close') ownedTabs.delete(data?.closed ?? tab_id ?? sessionTabId);
      if (action === 'close' && (tab_id == null || tab_id === sessionTabId)) sessionTabId = null;
      if (action === 'activate' && tab_id != null) sessionTabId = tab_id;
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- upload_file ---
  server.tool(
    'upload_file',
    'Set a file on input[type=file] from the server filesystem via DataTransfer (max 200 MB; over 6 MB it travels in pieces). Keys and credentials (~/.ssh, ~/.aws, '
      + '~/.gnupg, .env*, *.pem, *.key, id_*…) are refused, and a --read-root on the server limits the readable tree: the call fails '
      + 'with an error, nothing is read.',
    {
      selector: z.string().describe('The file input to fill; ">>>" pierces shadow DOM'),
      path: z.string().describe('Absolute path on the server machine; keys and credentials (~/.ssh, .env, *.pem) refused'),
      mime_type: z.string().optional().describe('Default: inferred from extension'),
      tab_id: tabId,
    },
    async ({ selector, path, mime_type, tab_id }) => {
      const abs = await guardRead(path);
      const { size } = await stat(abs);
      if (size > MAX_UPLOAD_BYTES) throw new Error(`File too large: ${size} bytes (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
      const buf = await readFile(abs);
      const mime = mime_type || MIME_BY_EXT[extname(path).toLowerCase()] || 'application/octet-stream';
      const data = await uploadBuffer(send, { selector, name: basename(path), mime_type: mime, buf, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- dismiss_overlays ---
  server.tool(
    'dismiss_overlays',
    'Dismiss cookie banners/modal overlays: OneTrust, Cookiebot, Usercentrics, then generic heuristic. Idempotent.',
    {
      tab_id: tabId,
    },
    async ({ tab_id }) => {
      const data = await send(MessageType.DISMISS_OVERLAYS, { tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- handle_dialogs ---
  server.tool(
    'handle_dialogs',
    'Auto-accept/dismiss future JS dialogs (alert/confirm/prompt), logging them. reset restores native dialogs and returns the log.',
    {
      action: z.enum(['accept', 'dismiss', 'reset']).optional().default('accept').describe('accept/dismiss auto-answer future dialogs; reset restores native behaviour'),
      prompt_text: z.string().optional().describe('Returned by window.prompt on accept'),
      tab_id: tabId,
    },
    async ({ action, prompt_text, tab_id }) => {
      const data = await send(MessageType.HANDLE_DIALOGS, { action, prompt_text, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- find_text ---
  server.tool(
    'find_text',
    'Find text on the page: parent selector, context, visibility, position per match. Attaches nearby interactive elements (with refs for click/type_text/hover) for the first visible match.',
    {
      text: z.string().describe('Literal text to find, not a regex'),
      case_sensitive: z.boolean().optional().default(false).describe('Match case exactly'),
      max_results: z.number().optional().default(20).describe('Cap on matches returned, in document order'),
      tab_id: tabId,
    },
    async ({ text, case_sensitive, max_results, tab_id }) => {
      const data = await send(MessageType.FIND_TEXT, { text, case_sensitive, max_results, tab_id });
      // Interactives vicini al primo match visibile, con ref: rende il match
      // azionabile subito (click sul bottone della stessa riga/sezione).
      // Nota coordinate: match.position è in coordinate pagina, i rect degli
      // interactives in coordinate viewport — coincidono a scroll 0 (il flusso
      // tipico navigate → find_text). Con pagina scrollata il filtro per
      // distanza non trova candidati e non allega nulla: degradazione sicura.
      let near = null;
      const first = (data?.matches ?? []).find((m) => m.visible && m.position);
      if (first) {
        try {
          const inter = await send(MessageType.GET_INTERACTIVES, { limit: 3000, visible_only: true, tab_id });
          const els = (inter?.elements ?? [])
            .map((e) => ({ e, dy: Math.abs((e.rect?.y ?? Infinity) - first.position.y), dx: Math.abs((e.rect?.x ?? Infinity) - first.position.x) }))
            .filter((c) => c.dy <= 150)
            .sort((a, b) => (a.dy * 4 + a.dx) - (b.dy * 4 + b.dx))
            .slice(0, 5)
            .map((c) => c.e);
          if (els.length) {
            assignRefs(tab_id, els);
            near = truncateText(interactivesLines({ count: els.length, elements: els, note: 'near first match' }), 1200);
          }
        } catch {}
      }
      return { content: [{ type: 'text', text: jsonText(data) + (near ? `\n${near}` : '') }] };
    }
  );

  // --- network_rules ---
  server.tool(
    'network_rules',
    'Network interception, browser-wide, survives reloads until cleared: block, redirect, set/remove headers, stub a synthetic body, or record real API responses and replay them with forced errors/latency (local helper; from HTTPS pages the stub host must be trusted).',
    {
      action: z.enum(['block', 'redirect', 'modify_header', 'stub', 'record', 'replay', 'list', 'clear']).describe('record saves the page\'s API responses (url_filter) as a fixture, replay serves them with overrides; list/clear'),
      name: z.string().optional().describe('Fixture name for record/replay'),
      overrides: z.array(z.object({ url_contains: z.string(), status: z.number().optional(), body: z.string().optional(), latency_ms: z.number().optional() })).optional()
        .describe('replay: force a status, body or delay on matching URLs — error states a real backend will not produce'),
      url_filter: z.string().optional().describe('declarativeNetRequest urlFilter, e.g. "||example.com/api/*"'),
      redirect_url: z.string().optional().describe('Destination for action=redirect'),
      header: z.string().optional().describe('Header name for action=modify_header, e.g. "User-Agent"'),
      header_value: z.string().optional().describe('Omit to remove header'),
      header_target: z.enum(['request', 'response']).optional().default('request').describe("response = strip content-security-policy / x-frame-options, inject CORS"),
      body: z.string().optional().describe('Response body (action=stub)'),
      status: z.number().optional().default(200).describe('action=stub'),
      content_type: z.string().optional().default('application/json').describe('action=stub'),
      resource_types: z.array(z.enum(['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'])).optional().describe('Limit the rule to these request types; omitted = all of them'),
    },
    async ({ action, url_filter, redirect_url, header, header_value, header_target, body, status, content_type, resource_types, name, overrides }) => {
      // "testa lo stato d'errore": le risposte vere dell'API, salvate una volta
      // (rifatte adesso con i cookie dell'utente) e riservite con status,
      // corpo o latenza forzati.
      if (action === 'record') {
        if (!name || !/^[\w-]+$/.test(name)) throw new Error('record needs name matching [\\w-]+');
        const log = await send(MessageType.MONITOR_NETWORK, { source: 'page', limit: 0 });
        // urlFilter di declarativeNetRequest → regex: via le ancore ||, |, poi glob
        const pat = String(url_filter ?? '').replace(/^\|\|/, '').replace(/^\|/, '').replace(/\|$/, '');
        const filter = url_filter ? new RegExp(pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')) : /./;
        const urls = [...new Set((log?.requests ?? []).filter((r) => r.url && filter.test(r.url) && (r.method ?? 'GET') === 'GET').map((r) => r.url))].slice(0, 50);
        // Fino a 50 richieste indipendenti: 6 alla volta invece di una dopo l'altra,
        // nello stesso ordine di prima nel file (come checkRedirects).
        const entries = new Array(urls.length);
        let next = 0;
        const worker = async () => {
          while (next < urls.length) {
            const idx = next++;
            const url = urls[idx];
            try { const r = await send(MessageType.HTTP_REQUEST, { url, method: 'GET' }); entries[idx] = { url, status: r.status, content_type: r.content_type || 'application/json', body: r.body ?? '' }; }
            catch (err) { entries[idx] = { url, error: err.message }; }
          }
        };
        await Promise.all(Array.from({ length: Math.min(6, urls.length) }, worker));
        await mkdir(FIXTURES_DIR, { recursive: true });
        const file = join(FIXTURES_DIR, `${name}.json`);
        await writeFile(file, JSON.stringify({ recorded_at: new Date().toISOString(), url_filter: url_filter ?? null, entries }, null, 1));
        return { content: [{ type: 'text', text: `recorded ${entries.filter((e) => !e.error).length} response(s) to ${file}` + (urls.length === 0 ? '\nnothing matched: monitor_network source=page must have been on while the page fetched' : '') + '\n' + entries.map((e) => `${e.status ?? 'ERR'}\t${e.url}`).join('\n') }] };
      }
      if (action === 'replay') {
        if (!name) throw new Error('replay needs name');
        const file = join(FIXTURES_DIR, `${name}.json`);
        const fx = JSON.parse(await readFile(file, 'utf8'));
        const port = await ensureStubServer();
        const rules = [];
        for (const e of fx.entries ?? []) {
          if (e.error) continue;
          const ov = (overrides ?? []).find((o) => e.url.includes(o.url_contains));
          const id = addStub({ body: ov?.body ?? e.body, status: ov?.status ?? e.status, content_type: e.content_type, delay_ms: ov?.latency_ms ?? 0 });
          const u = new URL(e.url);
          const exact = `|${u.origin}${u.pathname}${u.search ? '^' : '|'}`;
          await send(MessageType.NETWORK_RULES, { action: 'redirect', url_filter: exact, redirect_url: `http://${stubHost()}:${port}/__stub__/${id}`, resource_types: ['xmlhttprequest', 'other'] });
          rules.push(`${ov ? 'override ' : ''}${ov?.status ?? e.status}${ov?.latency_ms ? ` +${ov.latency_ms}ms` : ''}\t${e.url}`);
        }
        return { content: [{ type: 'text', text: `replaying ${rules.length} response(s) from ${file} — reload the page; network_rules clear stops it\n${rules.join('\n')}` }] };
      }
      if (action === 'stub') {
        if (!url_filter) throw new Error('url_filter is required for action=stub');
        if (body == null) throw new Error('body is required for action=stub');
        const port = await ensureStubServer();
        const id = addStub({ body, status: status ?? 200, content_type: content_type ?? 'application/json' });
        const stub_url = `http://${stubHost()}:${port}/__stub__/${id}`;
        const data = await send(MessageType.NETWORK_RULES, { action: 'redirect', url_filter, redirect_url: stub_url, resource_types });
        return { content: [{ type: 'text', text: jsonText({ ...data, stub: id, stub_url }) }] };
      }
      if (action === 'clear') clearStubs();
      const data = await send(MessageType.NETWORK_RULES, { action, url_filter, redirect_url, header, header_value, header_target, resource_types });
      if (action === 'list') {
        const stubsInfo = listStubs();
        if (stubsInfo.length) return { content: [{ type: 'text', text: jsonText({ ...data, stubs: stubsInfo }) }] };
      }
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- screenshot_diff ---
  server.tool(
    'screenshot_diff',
    'Visual regression: save a named baseline (viewport, element, or a PNG such as the design mockup) and compare later — changed-pixel % and a red-highlighted diff; or compare_urls: production vs staging in this tab, pixels plus text diff, logged-in pages included. Baselines are in-memory (lost on service worker restart).',
    {
      action: z.enum(['baseline', 'compare', 'compare_urls', 'list', 'clear']).describe('baseline stores, compare measures against it, compare_urls diffs url_a vs url_b here, clear drops baselines'),
      name: z.string().optional().default('default').describe('Baseline id: reuse the same one to compare across runs'),
      selector: z.string().optional().describe('Capture one element (default viewport)'),
      threshold: z.number().optional().default(10).describe('Per-channel tolerance 0-255'),
      from_file: z.string().optional().describe('action=baseline: take it from this PNG (design mockup) instead of capturing'),
      url_a: z.string().optional().describe('compare_urls: reference page, e.g. production'),
      url_b: z.string().optional().describe('compare_urls: page under test, e.g. staging or a PR preview'),
      mask: z.array(z.string()).optional().describe('compare_urls: selectors hidden on both pages (dates, carousels, ads)'),
      tab_id: tabId,
    },
    async ({ action, name, selector, threshold, from_file, url_a, url_b, mask, tab_id }) => {
      // Due URL, stessa tab, stesso viewport: produzione contro staging, anche
      // dietro login perché il browser è quello dell'utente. Il diff testuale
      // spesso basta a decidere senza guardare l'immagine.
      if (action === 'compare_urls') {
        if (!url_a || !url_b) throw new Error('compare_urls needs url_a and url_b');
        const settle = () => send(MessageType.WAIT_FOR_NETWORK_IDLE, { idle_ms: 600, timeout: 15000, tab_id }).catch(() => {});
        const hide = async () => { if (mask?.length) await send(MessageType.INJECT_CSS, { css: `${mask.join(', ')} { visibility: hidden !important; }`, tab_id }).catch(() => {}); };
        const textOf = async () => { const t = await send(MessageType.READ_PAGE, { mode: 'text', tab_id }); return (typeof t === 'string' ? t : JSON.stringify(t)).split('\n').map((l) => l.trim()).filter(Boolean); };
        const cmpName = `__compare_${Date.now()}`;
        await send(MessageType.NAVIGATE, { url: url_a, tab_id }); await settle(); await hide();
        const textA = await textOf();
        await send(MessageType.SCREENSHOT_DIFF, { action: 'baseline', name: cmpName, selector, tab_id });
        await send(MessageType.NAVIGATE, { url: url_b, tab_id }); await settle(); await hide();
        const textB = await textOf();
        const diff = await send(MessageType.SCREENSHOT_DIFF, { action: 'compare', name: cmpName, selector, threshold, tab_id });
        await send(MessageType.SCREENSHOT_DIFF, { action: 'clear', name: cmpName, tab_id }).catch(() => {});
        const setA = new Set(textA); const setB = new Set(textB);
        const onlyA = textA.filter((l) => !setB.has(l)); const onlyB = textB.filter((l) => !setA.has(l));
        const { diff_image, ...rest } = diff ?? {};
        const lines = [`compare_urls a=${url_a} b=${url_b}`, `pixels: ${rest.reason === 'size_mismatch' ? `size mismatch ${rest.baseline?.width}x${rest.baseline?.height} vs ${rest.current?.width}x${rest.current?.height}` : `${rest.diff_percent ?? rest.diffPercent ?? rest.changed_percent ?? JSON.stringify(rest)}% changed`}`,
          `text: ${onlyA.length} line(s) only in A, ${onlyB.length} only in B`,
          ...onlyA.slice(0, 15).map((l) => `- ${l.slice(0, 160)}`), ...onlyB.slice(0, 15).map((l) => `+ ${l.slice(0, 160)}`)];
        const content = [{ type: 'text', text: lines.join('\n') }];
        if (diff_image) content.push({ type: 'image', data: diff_image, mimeType: 'image/png' });
        return { content };
      }
      // Baseline da file: il mockup del designer o lo screenshot di produzione
      // diventano il riferimento; l'estensione riceve i byte, non un percorso.
      const image_b64 = action === 'baseline' && from_file ? (await readFile(from_file)).toString('base64') : undefined;
      const data = await send(MessageType.SCREENSHOT_DIFF, { action, name, selector, threshold, image_b64, tab_id });
      if (data && data.diff_image) {
        const { diff_image, ...rest } = data;
        return {
          content: [
            { type: 'text', text: jsonText(rest) },
            { type: 'image', data: diff_image, mimeType: 'image/png' },
          ],
        };
      }
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- track_events ---
  server.tool(
    'track_events',
    'Decode the tracking beacons the page fired (GA4, Meta Pixel, Google Ads, TikTok, LinkedIn, Pinterest, Microsoft Ads, GTM, Hotjar, Clarity) '
      + 'from the browser network log: one line per event with its key params. Read-only; POST-body params are flagged, not decoded.',
    {
      clear: z.boolean().optional().default(false).describe('Clear the browser log first — call it right before the action you want to observe'),
      wait_ms: z.number().optional().default(0).describe('Time to wait before reading, for beacons sent after the action'),
      tab_id: tabId,
    },
    async ({ clear, wait_ms, tab_id }) => {
      if (clear) await send(MessageType.MONITOR_NETWORK, { source: 'browser', clear: true, limit: 1, tab_id });
      if (wait_ms > 0) await new Promise((r) => setTimeout(r, Math.min(wait_ms, 60000)));
      const data = await send(MessageType.MONITOR_NETWORK, { source: 'browser', limit: 0, tab_id });
      const decoded = decodeTrackingRequests(data?.requests ?? []);
      return { content: [{ type: 'text', text: trackingLines(decoded) }] };
    }
  );

  // --- cookie_audit ---
  server.tool(
    'cookie_audit',
    'Cookie and consent-banner audit: clears this site\'s cookies, reloads, records cookies and third-party requests BEFORE consent, '
      + 'accepts the banner, records again; the findings name the trackers contacted before consent. Logs you out of the audited site.',
    {
      accept_selector: z.string().optional().describe('Accept button of the banner; omitted = dismiss_overlays; "none" skips consent'),
      settle_ms: z.number().optional().default(3000).describe('Wait after load and after consent, for late beacons'),
      tab_id: tabId,
    },
    async ({ accept_selector, settle_ms, tab_id }) => {
      const info = await send(MessageType.GET_PAGE_INFO, { tab_id });
      const pageUrl = info?.url;
      if (!/^https?:/.test(String(pageUrl))) throw new Error(`cookie_audit needs an http(s) page, current tab is ${pageUrl}`);
      const settle = () => new Promise((r) => setTimeout(r, Math.min(settle_ms ?? 3000, 30000)));
      await send(MessageType.SET_STORAGE, { type: 'cookie', action: 'clear', tab_id });
      await send(MessageType.MONITOR_NETWORK, { source: 'browser', clear: true, limit: 1, tab_id });
      await send(MessageType.NAVIGATE, { url: pageUrl, tab_id });
      await settle();
      const cookiesBefore = (await send(MessageType.GET_STORAGE, { type: 'cookies', tab_id }))?.cookies ?? [];
      const requestsBefore = (await send(MessageType.MONITOR_NETWORK, { source: 'browser', limit: 0, tab_id }))?.requests ?? [];
      let consent = 'none';
      if (accept_selector !== 'none') {
        await send(MessageType.MONITOR_NETWORK, { source: 'browser', clear: true, limit: 1, tab_id });
        if (accept_selector) { await send(MessageType.CLICK, { selector: accept_selector, tab_id }); consent = `click ${accept_selector}`; }
        else { const d = await send(MessageType.DISMISS_OVERLAYS, { tab_id }); consent = d?.dismissed || d?.removed ? 'dismiss_overlays' : 'dismiss_overlays (nothing found)'; }
        await settle();
      }
      const cookiesAfter = consent === 'none' ? [] : ((await send(MessageType.GET_STORAGE, { type: 'cookies', tab_id }))?.cookies ?? []);
      const requestsAfter = consent === 'none' ? [] : ((await send(MessageType.MONITOR_NETWORK, { source: 'browser', limit: 0, tab_id }))?.requests ?? []);
      const summary = summarizeConsent({ pageUrl, cookiesBefore, requestsBefore, cookiesAfter, requestsAfter, consent });
      return { content: [{ type: 'text', text: consentLines(summary) }] };
    }
  );

  // --- handoff ---
  server.tool(
    'handoff',
    'Hand the browser to the user for what only a person can do — 2FA, CAPTCHA, login, a choice — and wait: a banner in the page shows your '
      + 'message with Done/Cancel, the call returns on click or timeout, redirects included. pick_element: the user clicks an element and you get '
      + 'its selector. Never type credentials yourself. ask: the user types a reply in the banner ("which of the three?") and you get it as answer. '
      + 'pick_max: with pick_element, up to N elements; the user presses Done when finished.',
    {
      message: z.string().describe('What the user should do, one line'),
      pick_element: z.boolean().optional().default(false).describe('Ask the user to click an element; returns its selector, text and box'),
      ask: z.boolean().optional().default(false).describe('Show a text box in the banner; the reply comes back as answer'),
      pick_max: z.number().optional().default(1).describe('With pick_element: up to N elements, the user presses Done when finished'),
      timeout: z.number().optional().default(300000).describe('ms to wait for the click, default 5 min'),
      in_terminal: z.boolean().optional().default(true).describe('Also ask in the Claude Code terminal (MCP elicitation) when the client supports it; the first answer wins. Not for pick_element'),
      tab_id: tabId,
    },
    async ({ message, pick_element, ask, pick_max, timeout, in_terminal, tab_id }) => {
      const banner = send(MessageType.HANDOFF, { message, pick_element, ask, pick_max, timeout, tab_id });
      const d = in_terminal !== false && !pick_element ? await withTerminalAsk(banner, { message, ask, tab_id }) : await banner;
      const lines = [`handoff ${d.action}${d.url ? ` url=${d.url}` : ''}${d.via === 'terminal' ? ' via=terminal' : ''}`];
      if (ask && typeof d.answer === 'string' && d.answer.trim()) lines.push(`answer: ${d.answer.trim()}`);
      const fmt = (p) => `${p.selector}\t${p.tag}\t${p.text}\t@${p.rect.x},${p.rect.y} ${p.rect.width}x${p.rect.height}`;
      if (Array.isArray(d.picked_all) && d.picked_all.length) {
        d.picked_all.forEach((p, i) => lines.push(`picked ${i + 1}/${d.picked_all.length} ${fmt(p)}`));
      } else if (d.picked) {
        lines.push(`picked ${fmt(d.picked)}`);
      }
      if (d.action === 'timeout') lines.push('the user did not click within the timeout: ask before retrying');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // handoff anche nel terminale: chi lavora con Claude Code spesso guarda il
  // terminale, non il browser. Una richiesta form (elicitation MCP) corre in
  // parallelo al banner e vince la prima risposta: dal terminale si chiude il
  // banner (handoff_end), dal banner si annulla la richiesta nel terminale.
  // La modalità URL dell'elicitation non serve qui: aprirebbe il link nel
  // browser predefinito, che può non essere il Chrome in cui lavora l'agente.
  async function withTerminalAsk(banner, { message, ask, tab_id }) {
    const lowLevel = lowLevelServer;
    if (!lowLevel?.getClientCapabilities?.()?.elicitation) return banner;
    const abort = new AbortController();
    const requestedSchema = ask
      ? { type: 'object', properties: { answer: { type: 'string', title: 'Reply' } }, required: ['answer'] }
      : { type: 'object', properties: {} };
    const terminal = lowLevel.elicitInput(
      { mode: 'form', message: `${message}\n\nDo it in Chrome (a banner there waits too), then accept here; decline to cancel.`, requestedSchema },
      { signal: abort.signal, timeout: 24 * 3600 * 1000 },
    ).then((r) => ({ from: 'terminal', r }), () => null);
    const first = await Promise.race([banner.then((d) => ({ from: 'banner', d })), terminal.then((t) => t ?? banner.then((d) => ({ from: 'banner', d })))]);
    if (first.from === 'banner') {
      abort.abort();
      return first.d;
    }
    const accepted = first.r.action === 'accept';
    await send(MessageType.HANDOFF_END, { action: accepted ? 'done' : 'cancel', ...(accepted && ask && { answer: String(first.r.content?.answer ?? '') }), tab_id }).catch(() => {});
    return banner;
  }

  // --- watch ---
  server.tool(
    'watch',
    'Keep watching a page in the background — "tell me when the pipeline is green / the Approve button appears / this number changes" — '
      + 'checked every interval_s by the extension. Events are collected, not pushed: action=poll, or a script blocking on '
      + '"chrome-bridge watch --wait <name>". Survives extension idling, not a browser restart.',
    {
      action: z.enum(['add', 'poll', 'list', 'remove']).optional().default('add').describe('poll = events since a timestamp'),
      name: z.string().optional().describe('Watch id'),
      selector: z.string().optional().describe('Element that appears (until=match) or disappears (until=gone)'),
      text: z.string().optional().describe('Text that appears / disappears'),
      value_of: z.string().optional().describe('Element whose text changing fires (until=change)'),
      until: z.enum(['match', 'gone', 'change']).optional().describe('Default: change with value_of, else match'),
      interval_s: z.number().optional().default(60).describe('Between checks, min 30'),
      expires_min: z.number().optional().default(240).describe('Give up after'),
      reload: z.boolean().optional().default(false).describe('Reload before each check, for pages that do not update live'),
      since: z.number().optional().describe('poll: events after this ms timestamp'),
      tab_id: tabId,
    },
    async ({ action, name, selector, text, value_of, until, interval_s, expires_min, reload, since, tab_id }) => {
      const d = await send(MessageType.WATCH, { action, name, selector, text, value_of, until, interval_s, expires_min, reload, since, tab_id });
      if (action === 'poll') {
        const lines = (d.events ?? []).map((e) => `${new Date(e.ts).toISOString()}\t${e.name}\t${e.kind}${e.url ? `\t${e.url}` : ''}${e.value != null ? `\tvalue=${String(e.value).slice(0, 80)}` : ''}${e.previous != null ? `\tprevious=${String(e.previous).slice(0, 80)}` : ''}`);
        return { content: [{ type: 'text', text: `watch events=${lines.length} now=${d.now}\n${lines.join('\n')}` }] };
      }
      if (action === 'list') {
        const lines = (d.watches ?? []).map((w) => `${w.name}\t${w.until}\t${w.selector ?? w.text ?? w.value_of}\tevery ${w.interval_s}s\tchecks=${w.checks}\ttab ${w.tabId}`);
        return { content: [{ type: 'text', text: `watches=${lines.length}\n${lines.join('\n')}` }] };
      }
      return { content: [{ type: 'text', text: jsonText(d) }] };
    }
  );

  // --- read_form ---
  server.tool(
    'read_form',
    'Read a form as the user filled it — label, type, value, checked/selected, required-but-empty, browser validity — to check it against the '
      + 'project\'s documents before an irreversible Submit. Password and card values come back [redacted]. Read-only, on request.',
    {
      selector: z.string().optional().describe('The form or container; omitted = every visible control on the page'),
      tab_id: tabId,
    },
    async ({ selector, tab_id }) => {
      const d = await send(MessageType.READ_FORM, { selector, tab_id });
      if (d?.error) return { content: [{ type: 'text', text: d.error }] };
      const lines = (d.controls ?? []).map((c) => [c.label || c.name || c.selector, c.type, typeof c.value === 'boolean' ? (c.value ? 'checked' : 'unchecked') : Array.isArray(c.value) ? c.value.join('|') : (c.value === '' ? '(empty)' : String(c.value).slice(0, 120)), c.selector, c.empty_required ? 'REQUIRED EMPTY' : !c.valid ? `INVALID${c.validation ? `: ${c.validation}` : ''}` : c.required ? 'required' : '', c.disabled ? 'disabled' : ''].filter((x) => x !== '').join('\t'));
      return { content: [{ type: 'text', text: `form controls=${d.count ?? lines.length} empty_required=${d.empty_required ?? 0} invalid=${d.invalid ?? 0} url=${d.url ?? ''}\n${lines.join('\n')}\nreview: compare each value with the source of truth (documents, previous records) and list what does not match and what you could not check — never a bare "all good"` }] };
    }
  );

  // --- audit ---
  server.tool(
    'audit',
    'One-call page audit, pick the kinds: accessibility, keyboard (tab order and focus issues), SEO, security headers, broken links, '
      + 'Core Web Vitals, unused CSS, resources (which plugin/theme/module/host slows the page), cache (is the CDN serving the new version). '
      + 'A summary line per kind; with save_to the full Markdown report with every finding. Read-only.',
    {
      kinds: z.array(z.enum(AUDIT_KINDS)).optional().default(DEFAULT_KINDS).describe('Default skips keyboard, css (slow, approximate), resources and cache'),
      save_to: saveToField('the full Markdown report'),
      scope: z.string().optional().describe('a11y only: limit to this subtree'),
      max_links: z.number().optional().default(50).describe('links only: cap on URLs fetched'),
      tab_id: tabId,
    },
    async ({ kinds, save_to, scope, max_links, tab_id }) => {
      guardWrite(save_to);
      const info = await send(MessageType.GET_PAGE_INFO, { tab_id });
      const results = await runAudit(send, { kinds, scope, max_links, tab_id });
      const summary = summarizeAudit(results);
      let text = `audit ${info?.url ?? ''}\n${summary.lines.join('\n')}`;
      if (save_to) {
        await writeFile(save_to, auditReport({ url: info?.url, title: info?.title, results, summary }));
        text += `\nreport: ${save_to}`;
      } else {
        text += '\n(pass save_to for the full report with every finding)';
      }
      return { content: [{ type: 'text', text }] };
    }
  );

  // --- find_setting ---
  server.tool(
    'find_setting',
    'Where is a setting in an unknown admin panel: follows the panel\'s menu links (same origin) until a page contains the keyword and '
      + 'reports the menu path. Navigates the tab, leaves it on the page found, stops at max_pages.',
    {
      keyword: z.string().describe('What you are looking for, e.g. "webp", "cron", "maintenance mode"'),
      max_pages: z.number().optional().default(25).describe('Pages visited at most'),
      menu_selector: z.string().optional().default('nav, aside, [role="navigation"], #adminmenu, .menu, .sidebar, .navbar, .tabs').describe('Where the menu links are'),
      tab_id: tabId,
    },
    async ({ keyword, max_pages, menu_selector, tab_id }) => {
      const kw = keyword.toLowerCase();
      const found = async () => {
        const r = await send(MessageType.FIND_TEXT, { text: keyword, max_results: 3, tab_id });
        return r?.matches?.length ? r.matches[0] : null;
      };
      const menuLinks = async () => {
        const r = await send(MessageType.COLLECT_LINKS, { scope: 'same-origin', selector: `:is(${menu_selector}) a[href]`, max_links: 200, tab_id });
        return (r?.links ?? []).map((l) => ({ url: l.url, text: (l.text ?? '').trim() }));
      };
      const info = await send(MessageType.GET_PAGE_INFO, { tab_id });
      const start = info?.url;
      const visited = new Set([start]);
      const hit = await found();
      if (hit) return { content: [{ type: 'text', text: `found on the current page ${start}\n${JSON.stringify(hit)}` }] };
      const queue = [];
      const enqueue = (links, via) => {
        for (const l of links) {
          if (!l.url || visited.has(l.url) || queue.some((q) => q.url === l.url)) continue;
          queue.push({ ...l, via, score: l.text.toLowerCase().includes(kw) ? 0 : 1 });
        }
        queue.sort((a, b) => a.score - b.score);
      };
      enqueue(await menuLinks(), []);
      let pages = 0;
      while (queue.length && pages < max_pages) {
        const next = queue.shift();
        visited.add(next.url);
        pages += 1;
        try {
          await send(MessageType.NAVIGATE, { url: next.url, tab_id });
        } catch { continue; }
        const m = await found();
        const path = [...next.via, next.text].filter(Boolean).join(' › ');
        if (m) return { content: [{ type: 'text', text: `found after ${pages} page(s): ${next.url}\nmenu path: ${path}\n${JSON.stringify(m)}` }] };
        if (next.via.length < 1) enqueue(await menuLinks(), [...next.via, next.text]);
      }
      return { content: [{ type: 'text', text: `not found in ${pages} page(s) reached from the menu (${visited.size - 1} links tried, ${queue.length} left). Try another keyword, a wider menu_selector or a higher max_pages.` }] };
    }
  );

  // --- extract_table ---
  server.tool(
    'extract_table',
    'Read a real <table> as JSON: thead cells become keys, each row an object. Read-only. '
      + 'Only for tabular markup — `where` filters rows server-side, so one matching row out of 1500 '
      + 'costs a few hundred bytes instead of the whole document. `row_count` is the table total, '
      + '`match_count` how many rows passed the filter.',
    {
      selector: z.string().optional().default('table').describe('The table to read; ">>>" pierces shadow DOM'),
      index: z.number().optional().default(0).describe('Which table to take when the selector matches several, 0-based'),
      max_rows: z.number().optional().default(100).describe('Max rows returned to you (output cap).'),
      where: z.record(z.string(), z.string()).optional().describe('{column: substring} rows must match, case-insensitive (names too). Key "any" matches any cell.'),
      columns: z.array(z.string()).optional().describe('Return only these columns per row.'),
      offset: z.number().optional().default(0).describe('Skip N rows of the (filtered) set before applying max_rows.'),
      scan_rows: z.number().optional().default(2000).describe('Max rows materialized in-page to scan/filter; raise for very large tables.'),
      tab_id: tabId,
    },
    async ({ selector, index, max_rows, where, columns, offset, scan_rows, tab_id }) => {
      const data = await send(MessageType.EXTRACT_TABLE, { selector, index, scan_rows, tab_id });
      const shaped = shapeTable(data, { where, columns, offset, max_rows });
      return { content: [{ type: 'text', text: jsonText(shaped) }] };
    }
  );

  // --- drag_and_drop ---
  server.tool(
    'drag_and_drop',
    'Drag an element onto another. html5 = DragEvent+DataTransfer; pointer = pointer/mouse events (sortable libraries).',
    {
      source_selector: z.string().describe('Element to drag; ">>>" pierces shadow DOM'),
      target_selector: z.string().describe('Drop target; ">>>" pierces shadow DOM'),
      mode: z.enum(['html5', 'pointer']).optional().default('html5').describe('Which event family to emit, since libraries listen to different ones'),
      frame_id: frameId,
      tab_id: tabId,
    },
    async ({ source_selector, target_selector, mode, frame_id, tab_id }) => {
      const data = await send(MessageType.DRAG_AND_DROP, { source_selector, target_selector, mode, frame_id, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- clipboard ---
  server.tool(
    'clipboard',
    'Read or write the system clipboard (text). Activates the tab first. '
    + 'write overwrites whatever the user had copied, which is not recoverable.',
    {
      action: z.enum(['read', 'write']).describe('write takes text; read returns the current clipboard contents'),
      text: z.string().optional().describe('For write'),
      tab_id: tabId,
    },
    async ({ action, text, tab_id }) => {
      const data = await send(MessageType.CLIPBOARD, { action, text, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- set_geolocation ---
  server.tool(
    'set_geolocation',
    'Override navigator.geolocation with fixed coordinates (page-level patch). reset restores native.',
    {
      latitude: z.number().optional().describe('Decimal degrees, -90 to 90'),
      longitude: z.number().optional().describe('Decimal degrees, -180 to 180'),
      accuracy: z.number().optional().default(10).describe('Meters'),
      reset: z.boolean().optional().default(false).describe('Restore the real position and stop overriding'),
      tab_id: tabId,
    },
    async ({ latitude, longitude, accuracy, reset, tab_id }) => {
      const data = await send(MessageType.SET_GEOLOCATION, { latitude, longitude, accuracy, reset, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- manage_downloads ---
  server.tool(
    'manage_downloads',
    'List downloads, start one, or wait for the newest to finish. Files land in the browser Downloads folder, not on the server. '
      + 'download reports the real state: with Chrome set to ask where to save, it comes back waiting_for_user — bytes fetched, '
      + 'nothing moves until someone picks a destination.',
    {
      action: z.enum(['list', 'wait_for_complete', 'download']).describe('download fetches with the browser cookies and reports the real state; wait_for_complete blocks until the newest finishes'),
      url: z.string().optional().describe('What to download (action=download); sent with the session cookies of its origin'),
      filename: z.string().optional().describe('Relative path inside the Downloads folder (action=download)'),
      timeout: z.number().optional().default(30000).describe('Max ms (wait_for_complete)'),
      limit: z.number().optional().default(10).describe('Max download entries returned, newest first'),
    },
    async ({ action, url, filename, timeout, limit }) => {
      if (action === 'download' && !url) throw new Error('action=download requires url');
      const data = await send(MessageType.MANAGE_DOWNLOADS, { action, url, filename, timeout, limit });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- save_page ---
  server.tool(
    'save_page',
    'Save the full page (DOM, styles, images) as an MHTML archive file on the server filesystem.',
    {
      output_path: z.string().describe('Absolute file path to write (e.g. /tmp/page.mhtml)'),
      tab_id: tabId,
    },
    async ({ output_path, tab_id }) => {
      guardWrite(output_path);
      const data = await send(MessageType.SAVE_PAGE, { tab_id });
      await writeFile(output_path, Buffer.from(data.mhtml_b64, 'base64'));
      return { content: [{ type: 'text', text: jsonText({ saved: output_path, size: data.size }) }] };
    }
  );

  // --- http_request ---
  server.tool(
    'http_request',
    'HTTP request sent from the browser, with the logged-in user\'s cookies: fetches what a server-side request gets a login page for '
      + '(invoices, authenticated JSON, exports). Text bodies inline (capped by max_length); save_to writes the bytes — the way to read a PDF, '
      + 'since read_page returns nothing on a PDF tab.',
    {
      url: z.string().describe('Absolute URL. Cookies are sent for its origin'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional().default('GET').describe('HEAD fetches headers only, without the body'),
      headers: z.record(z.string(), z.string()).optional().describe('Extra request headers'),
      body: z.string().optional().describe('Request body (POST/PUT/PATCH)'),
      save_to: z.string().optional().describe('Absolute path: write the response bytes here instead of returning them (PDF, images, archives)'),
      max_length: z.number().optional().default(DEFAULT_MAX_OUTPUT).describe('Max chars of body returned inline'),
    },
    async ({ url, method, headers, body, save_to, max_length }) => {
      guardWrite(save_to);
      const data = await send(MessageType.HTTP_REQUEST, { url, method, headers, body, binary: Boolean(save_to) });

      if (save_to) {
        // Il base64 non deve mai raggiungere il modello: un PDF di 300 kB sono
        // ~100k token di rumore per un contenuto che va letto da file.
        await writeFile(save_to, Buffer.from(data.body_b64 ?? '', 'base64'));
        return {
          content: [{
            type: 'text',
            text: jsonText({
              saved: save_to,
              status: data.status,
              ok: data.ok,
              content_type: data.content_type,
              size: data.size,
              url: data.url,
            }),
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: truncateText(
            jsonText({
              status: data.status,
              ok: data.ok,
              content_type: data.content_type,
              size: data.size,
              url: data.url,
              headers: data.headers,
              body: data.body,
            }, max_length ?? DEFAULT_MAX_OUTPUT, 'max_length'),
            max_length ?? DEFAULT_MAX_OUTPUT,
            'max_length',
          ),
        }],
      };
    }
  );

  // --- move_tab ---
  server.tool(
    'move_tab',
    'Move an existing tab into another window (chrome.tabs.move), keeping id, history and page state; works on chrome-untrusted:// '
      + 'tabs too. The **destination** must be a normal window: out of an app/popup window is fine, into one is refused. A ChromeOS '
      + 'Terminal tab can be pulled out (new_window, window_type popup) but never merged back: extensions cannot create app windows.',
    {
      tab_id: z.number().describe('Tab to move; get it from get_tabs'),
      window_id: z.number().optional().describe('Destination window; get_tabs reports windowId for every tab'),
      new_window: z.boolean().optional().default(false).describe('Extract the tab into a fresh window instead of an existing one'),
      window_type: z.enum(['normal', 'popup']).optional().default('normal').describe('new_window only: popup has no tab strip nor omnibox, the terminal-window look'),
      left: z.number().optional().describe('New window x (new_window)'),
      top: z.number().optional().describe('New window y (new_window)'),
      width: z.number().optional().describe('New window width px (new_window)'),
      height: z.number().optional().describe('New window height px (new_window)'),
      index: z.number().optional().default(-1).describe('Position in the destination window; -1 appends at the end'),
    },
    async ({ tab_id, window_id, new_window, window_type, left, top, width, height, index }) => {
      if (window_id == null && new_window !== true) {
        throw new Error('Provide window_id (an existing window) or new_window: true');
      }
      const data = await send(MessageType.MOVE_TAB, { tab_id, window_id, new_window: new_window === true || undefined, window_type, left, top, width, height, index: index ?? -1 });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- tile_windows ---
  server.tool(
    'tile_windows',
    'Tile Chrome windows over one monitor in equal parts with no gap. Only Chrome windows. The monitor is the one of a '
      + 'window already on it, whose work area is read from a page there: at least one target needs a scriptable tab '
      + '(not chrome://). Maximized windows are restored first, since maximized ignores bounds.',
    {
      window_ids: z.array(z.number()).optional().describe('Windows to tile; omitted = every normal window on the reference monitor'),
      reference_window_id: z.number().optional().describe('Window whose monitor is used; omitted = the focused one'),
      layout: z.enum(['grid', 'columns', 'rows']).optional().default('grid').describe('columns splits left to right, rows top to bottom, grid keeps tiles as square as it can'),
      padding: z.number().optional().default(0).describe('Px of empty margin kept inside the work area'),
      include_types: z.array(z.enum(['normal', 'popup', 'app'])).optional().describe('Window types to include; omitted = normal only'),
      area: z.object({
        left: z.number(), top: z.number(), width: z.number(), height: z.number(),
      }).optional().describe('Monitor area to fill, when no target window has a scriptable tab to read it from'),
    },
    async ({ window_ids, reference_window_id, layout, padding, include_types, area }) => {
      const data = await send(MessageType.TILE_WINDOWS, {
        window_ids, reference_window_id, layout: layout ?? 'grid', padding: padding ?? 0, include_types, area,
      });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- window_layout ---
  server.tool(
    'window_layout',
    'Save the current window arrangement under a name, restore, list or delete. save overwrites silently. Window ids do not survive '
      + 'a browser restart: restore matches windows by the overlap of their tab URLs and reports the ones it cannot recognise instead of guessing.',
    {
      action: z.enum(['save', 'restore', 'list', 'delete']).describe('save snapshots every window; restore repositions the recognised ones'),
      name: z.string().optional().describe('Layout name, required except for list'),
    },
    async ({ action, name }) => ({ content: [{ type: 'text', text: jsonText(await windowLayout(send, { action, name })) }] })
  );

  // --- http_auth ---
  server.tool(
    'http_auth',
    'Set/clear credentials for HTTP Basic/Digest auth dialogs (browser-wide, in-memory only).',
    {
      action: z.enum(['set', 'clear']).describe('set installs credentials for HTTP auth prompts; clear removes them'),
      username: z.string().optional().describe('Required for action=set'),
      password: z.string().optional().describe('Required for action=set; kept in memory, never written to disk'),
    },
    async ({ action, username, password }) => {
      if (action === 'set' && !username) throw new Error('username is required for action=set');
      const data = await send(MessageType.HTTP_AUTH, { action, username, password });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- session_fixture ---
  server.tool(
    'session_fixture',
    'Snapshot localStorage, sessionStorage and cookies of the current origin into a named fixture (a logged-in state, usually), '
      + 'restore one, or list them. save overwrites silently; restore writes on top without clearing and refuses on a different origin '
      + '— cookies would attach to the wrong site.',
    {
      action: z.enum(['save', 'restore', 'list']).describe('save snapshots the current origin; restore writes it back'),
      name: z.string().optional().describe('Required for save/restore'),
      tab_id: tabId,
    },
    async ({ action, name, tab_id }) => {
      if (action === 'list') {
        const { readdir } = await import('node:fs/promises');
        let files = [];
        try { files = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith('.json')); } catch {}
        return { content: [{ type: 'text', text: jsonText({ fixtures: files.map((f) => f.replace(/\.json$/, '')) }) }] };
      }
      if (!name || !/^[\w-]+$/.test(name)) throw new Error('name is required and must match [\\w-]+');
      const file = join(SESSIONS_DIR, `${name}.json`);

      // Origin del tab target (match per tab_id, altrimenti tab attivo)
      const getTabOrigin = async () => {
        const tabs = await send(MessageType.GET_TABS);
        const list = Array.isArray(tabs) ? tabs : [];
        const tab = tab_id != null ? list.find((t) => t.id === tab_id) : list.find((t) => t.active);
        try { return tab?.url ? new URL(tab.url).origin : null; } catch { return null; }
      };

      if (action === 'save') {
        const data = await send(MessageType.GET_STORAGE, { type: 'all', tab_id });
        const origin = await getTabOrigin();
        await mkdir(SESSIONS_DIR, { recursive: true });
        // File su disco per umani: pretty-print qui non costa token
        await writeFile(file, JSON.stringify({ savedAt: new Date().toISOString(), origin, ...data }, null, 2));
        return { content: [{ type: 'text', text: jsonText({ saved: name, origin, localStorage: Object.keys(data.localStorage || {}).length, sessionStorage: Object.keys(data.sessionStorage || {}).length, cookies: (data.cookies || []).length }) }] };
      }

      // restore
      const fixture = JSON.parse(await readFile(file, 'utf8'));
      if (fixture.origin) {
        const currentOrigin = await getTabOrigin();
        if (currentOrigin && currentOrigin !== fixture.origin) {
          throw new Error(`Fixture was saved on ${fixture.origin}, current tab is ${currentOrigin} — cookies/storage would attach to the wrong site. Navigate there first.`);
        }
      }
      const restored = { localStorage: 0, sessionStorage: 0, cookies: 0, cookie_errors: [] };
      // Scritture indipendenti fra loro: tutte insieme, non una per giro.
      await Promise.all(['localStorage', 'sessionStorage'].flatMap((storageType) => Object.entries(fixture[storageType] || {})
        .map(async ([k, v]) => {
          await send(MessageType.SET_STORAGE, { type: storageType, action: 'set', key: k, value: v, tab_id });
          restored[storageType]++;
        })));
      await Promise.all((fixture.cookies || []).map(async (c) => {
        try {
          await send(MessageType.SET_STORAGE, {
            type: 'cookie', action: 'set', key: c.name, value: c.value,
            path: c.path, domain: c.domain && c.domain.startsWith('.') ? c.domain : undefined,
            expires: c.expirationDate ? new Date(c.expirationDate * 1000).toUTCString() : undefined,
            secure: c.secure, sameSite: c.sameSite === 'no_restriction' ? 'None' : c.sameSite === 'strict' ? 'Strict' : c.sameSite === 'lax' ? 'Lax' : undefined,
            http_only: c.httpOnly,
            tab_id,
          });
          restored.cookies++;
        } catch (err) {
          restored.cookie_errors.push({ name: c.name, error: err.message });
        }
      }));
      if (restored.cookie_errors.length === 0) delete restored.cookie_errors;
      return { content: [{ type: 'text', text: jsonText({ restored: name, ...restored }) }] };
    }
  );

  // --- get_interactives ---
  server.tool(
    'get_interactives',
    'List actionable elements (buttons, links, inputs, [role], [onclick]) with ready-to-use CSS selector, label, position, flags. Prefer this over dumping HTML to discover selectors.',
    {
      scope: z.string().optional().describe('Limit search (CSS selector)'),
      limit: z.number().optional().default(100).describe('Max elements returned; raise it on a dense page'),
      visible_only: z.boolean().optional().default(true)
        .describe('false also lists elements hidden or scrolled out of view'),
      format: z.enum(['lines', 'json']).optional().default('lines').describe('lines is compact; json adds full attributes per element'),
      since: z.string().optional().describe('cursor from the previous list: only added (+), changed (~) and removed elements; same scope, frame and tab'),
      frame_id: frameId,
      tab_id: tabId,
    },
    async ({ scope, limit, visible_only, format, since, frame_id, tab_id }) => {
      const data = await send(MessageType.GET_INTERACTIVES, { scope, limit, visible_only, frame_id, tab_id });
      const elements = data?.elements ?? [];
      // Ref stabili per selettore e frame, memorizzati per click/type_text/hover
      assignRefs(tab_id, elements, frame_id);
      const { cursor, diff, note } = interactivesDiff(since, { tab_id, frame_id, scope, visible_only }, elements);
      if ((format ?? 'lines') === 'json') {
        const body = diff
          ? { count: data?.count ?? elements.length, since, added: diff.added, changed: diff.changed, removed: diff.removed }
          : { ...data, ...(note && { since_note: note }) };
        return { content: [{ type: 'text', text: jsonText({ ...body, cursor }) }] };
      }
      const cursorLine = `\ncursor=${cursor} (pass as since to get only what changed)`;
      if (diff) {
        const { added, changed, removed } = diff;
        const head = `interactives count=${data?.count ?? elements.length} since=${since}`;
        const text = !added.length && !changed.length && !removed.length
          ? `${head}: no changes`
          : [`${head}: +${added.length} ~${changed.length} -${removed.length}`,
            ...added.map((e) => `+ ${interactiveLine(e)}`),
            ...changed.map((e) => `~ ${interactiveLine(e)}`),
            ...(removed.length ? [`removed: ${removed.join(' ')}`] : [])].join('\n');
        return { content: [{ type: 'text', text: truncateText(text, DEFAULT_MAX_OUTPUT) + cursorLine }] };
      }
      return {
        content: [{
          type: 'text',
          text: truncateText(interactivesLines(data) + (note ? `\nnote: ${note}` : ''), DEFAULT_MAX_OUTPUT) + cursorLine,
        }],
      };
    }
  );

  // --- extract ---
  server.tool(
    'extract',
    'Read repeated non-tabular structures — product cards, list items, search results — as one record per item: '
      + 'item_selector matches the repeating block, fields map output names to selectors relative to it. '
      + 'Read-only, deterministic, parsed server-side from the main-document HTML.',
    {
      item_selector: z.string().describe('CSS selector matching each item'),
      fields: z.record(z.string(), z.object({
        selector: z.string().optional().describe('Relative to the item (default: the item itself)'),
        attr: z.string().optional().describe('Attribute to read (default: text content)'),
      })).describe('field name → {selector, attr}'),
      max_items: z.number().optional().default(50).describe('Cap on records returned, in document order'),
      format: z.enum(['lines', 'json']).optional().default('lines').describe('lines is compact; json keeps one object per record'),
      tab_id: tabId,
      max_length: z.number().optional().default(20000).describe('Max output chars'),
      save_to: saveToField('the records as JSON'),
    },
    async ({ item_selector, fields, max_items, format, tab_id, max_length , save_to }) => {
      guardWrite(save_to);
      max_length = max_length ?? DEFAULT_MAX_OUTPUT;
      const html = await send(MessageType.READ_PAGE, { mode: 'html', tab_id });
      if (typeof html !== 'string') throw new Error('Could not read page HTML');
      const root = parseHtml(html);
      const names = Object.keys(fields);
      const nodes = root.querySelectorAll(item_selector);
      const items = nodes.slice(0, max_items ?? 50).map((node) => {
        const row = {};
        for (const name of names) {
          const { selector, attr } = fields[name];
          const el = selector ? node.querySelector(selector) : node;
          const value = el ? (attr ? el.getAttribute(attr) : el.text.trim().replace(/\s+/g, ' ')) : null;
          row[name] = value ?? null;
        }
        return row;
      });
      if (save_to) return savedSummary(save_to, Buffer.from(JSON.stringify({ total: nodes.length, shown: items.length, items }), 'utf8'), { total: nodes.length, shown: items.length });
      if ((format ?? 'lines') === 'json') {
        return { content: [{ type: 'text', text: truncateText(JSON.stringify({ total: nodes.length, shown: items.length, items }), max_length, 'max_items or max_length') }] };
      }
      const lines = [`extract total=${nodes.length} shown=${items.length}`, names.join('\t'),
        ...items.map((row) => names.map((n) => row[n] ?? '').join('\t'))];
      return { content: [{ type: 'text', text: truncateText(lines.join('\n'), max_length, 'max_items or max_length') }] };
    }
  );

  // --- assert ---
  server.tool(
    'assert',
    'Assert a page condition, polling until timeout: element exists/visible (optionally with count or containing text), text on page, tab url/title. Patterns: substring, or "/…/" for regex. Recorded flows replay it as a test.',
    {
      selector: z.string().optional().describe('Element the assertion is about; ">>>" pierces shadow DOM'),
      state: z.enum(['attached', 'visible']).optional().default('attached').describe('attached means present in the DOM, visible also requires a rendered box'),
      text: z.string().optional().describe('In the element (with selector) or anywhere on the page'),
      count: z.number().optional().describe('Exact match count for selector'),
      url: z.string().optional().describe('Tab url pattern'),
      title: z.string().optional().describe('Tab title pattern'),
      timeout: z.number().optional().default(5000).describe('Max ms to wait for the condition before failing'),
      tab_id: tabId,
    },
    async ({ selector, state, text, count, url, title, timeout, tab_id }) => {
      const params = { selector, state, text, count, url, title, timeout, tab_id: tab_id ?? sessionTabId ?? undefined };
      if (recording) {
        const { tab_id: _tab, ...rest } = params;
        appendFile(recording.file, JSON.stringify({ command: 'assert', params: rest }) + '\n').catch(() => {});
      }
      recordSuppressed++;
      try {
        const result = await runAssert(send, params);
        return { content: [{ type: 'text', text: jsonText(result) }] };
      } finally {
        recordSuppressed--;
      }
    }
  );

  // --- session_record ---
  server.tool(
    'session_record',
    'Record the commands of this session as a replayable jsonl (chrome-bridge replay --file <path>); observe what the user does in a tab ("watch how I do it") into the same format plus a readable procedure, never recording sensitive values; export a recording as a Playwright test for CI. Replays target the tab they navigate.',
    {
      action: z.enum(['start', 'stop', 'status', 'list', 'export', 'observe']).describe('start records this session; observe records what the USER does; stop writes the file; export makes a Playwright test'),
      name: z.string().optional().describe('Required for start, observe and export (recording name, or a .jsonl path)'),
      save_to: saveToField('the exported .spec.ts'),
      values: z.boolean().optional().default(false).describe('observe: record values of non-sensitive fields instead of {{field}} placeholders'),
      tab_id: tabId,
    },
    async ({ action, name, save_to, values, tab_id }) => {
      guardWrite(save_to);
      if (name && name.endsWith('.jsonl')) guardWrite(name);
      // "Guarda come faccio": la procedura la esegue l'umano nel suo browser,
      // noi la trascriviamo — mai i valori dei campi sensibili — nello stesso
      // jsonl che replay esegue, più un .md leggibile con i passi umani marcati.
      if (action === 'observe') {
        if (!name || !/^[\w-]+$/.test(name)) throw new Error('observe needs name matching [\\w-]+');
        if (recording) throw new Error(`Already recording "${recording.name}": stop it first`);
        const d = await send(MessageType.OBSERVE, { action: 'start', name, values, tab_id });
        recording = { name, file: join(RECORDINGS_DIR, `${name}.jsonl`), observe: true };
        return { content: [{ type: 'text', text: `observing "${name}" on tab ${d.tabId} (${d.url}) — a badge marks the tab; the user performs the procedure, then session_record stop. Sensitive fields are never recorded.` }] };
      }
      // Il flusso registrato nel browser reale diventa un test che gira in CI
      // senza bridge: i passi umani restano come page.pause(), lo stato loggato
      // non viene esportato e la testata lo dice.
      if (action === 'export') {
        if (!name) throw new Error('export needs name (a recording name or a .jsonl path)');
        const file = name.endsWith('.jsonl') ? name : join(RECORDINGS_DIR, `${name}.jsonl`);
        const steps = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
        const out = toPlaywrightTest(steps, { name: basename(file, '.jsonl') });
        const target = save_to || file.replace(/\.jsonl$/, '.spec.ts');
        await writeFile(target, out.source);
        return { content: [{ type: 'text', text: `exported ${out.steps} step(s) to ${target}` + (out.skipped.length ? `\nno Playwright equivalent (left as comments): ${[...new Set(out.skipped)].join(', ')}` : '') + '\nlogin state is not exported: use storageState or add the login steps' }] };
      }
      if (action === 'status') {
        return { content: [{ type: 'text', text: jsonText(recording ? { recording: recording.name, file: recording.file } : { recording: null }) }] };
      }
      if (action === 'list') {
        const { readdir } = await import('node:fs/promises');
        let files = [];
        try { files = (await readdir(RECORDINGS_DIR)).filter((f) => f.endsWith('.jsonl')); } catch {}
        return { content: [{ type: 'text', text: jsonText({ recordings: files.map((f) => join(RECORDINGS_DIR, f)) }) }] };
      }
      if (action === 'start') {
        if (!name || !/^[\w-]+$/.test(name)) throw new Error('name is required and must match [\\w-]+');
        await mkdir(RECORDINGS_DIR, { recursive: true });
        const file = join(RECORDINGS_DIR, `${name}.jsonl`);
        await writeFile(file, '');
        recording = { name, file };
        return { content: [{ type: 'text', text: jsonText({ recording: name, file }) }] };
      }
      // stop
      const stopped = recording;
      recording = null;
      if (stopped?.observe) {
        const d = await send(MessageType.OBSERVE, { action: 'stop' });
        const steps = (d.steps ?? []).map(({ ts, human, ...step }) => step);
        await mkdir(RECORDINGS_DIR, { recursive: true });
        await writeFile(stopped.file, steps.map((st) => JSON.stringify(st)).join('\n') + (steps.length ? '\n' : ''));
        const md = observedProcedure(stopped.name, d);
        const mdFile = stopped.file.replace(/\.jsonl$/, '.md');
        await writeFile(mdFile, md);
        const humanSteps = (d.steps ?? []).filter((st) => st.human?.sensitive).length;
        return { content: [{ type: 'text', text: `observed ${steps.length} step(s) on ${d.final_url ?? 'the tab'}\nreplayable: ${stopped.file}\nprocedure: ${mdFile}${humanSteps ? `\n${humanSteps} sensitive field(s) recorded as placeholders — the human fills them at replay` : ''}\n\n${md.split('\n').slice(0, 25).join('\n')}` }] };
      }
      await recordChain; // il file deve essere completo quando il tool ritorna
      return { content: [{ type: 'text', text: jsonText(stopped ? { stopped: stopped.name, file: stopped.file } : { stopped: null }) }] };
    }
  );

  // Per index.js allo shutdown: chiudi le tab create qui e rimaste vuote,
  // come fa Claude in Chrome col suo tab group; le pagine con contenuto restano.
  return {
    async closeEmptyOwnedTabs() {
      if (!ownedTabs.size || !wsManager.isConnected()) return [];
      let tabs = [];
      try { tabs = await wsManager.sendCommand(MessageType.GET_TABS, {}); } catch { return []; }
      const list = Array.isArray(tabs) ? tabs : (tabs?.tabs ?? []);
      const closed = [];
      for (const t of list) {
        if (!ownedTabs.has(t.id)) continue;
        if (/^(about:blank|chrome:\/\/newtab)/.test(t.url || '')) { try { await wsManager.sendCommand(MessageType.TAB_ACTION, { action: 'close', tab_id: t.id }); closed.push(t.id); } catch { /* già chiusa */ } }
      }
      return closed;
    },
  };

}
