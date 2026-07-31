/**
 * Registra i tool MCP sul server.
 *
 * Ogni tool crea un comando WebSocket, lo invia tramite il WSManager
 * e restituisce il risultato al client MCP.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { parse as parseHtml } from 'node-html-parser';
import { z } from 'zod';
import { runAssert } from './assertions.js';
import { ensureStubServer, addStub, clearStubs, listStubs, stubHost } from './stub-server.js';
import { MessageType, VERSION } from './protocol.js';
import { checkLinksBatch } from './link-checker.js';
import { toHar } from './har.js';
import { evaluateSecurityHeaders } from './security-headers.js';
import { consoleLines, networkLines, interactivesLines, linksLines } from './formatters.js';

const SESSIONS_DIR = join(homedir(), '.config', 'chrome-bridge', 'sessions');
// Sovrascrivibile nei test: i layout sono un file solo, non una directory.
const LAYOUTS_FILE = process.env.CHROME_BRIDGE_LAYOUTS_FILE
  || join(homedir(), '.config', 'chrome-bridge', 'layouts.json');
const RECORDINGS_DIR = process.env.CHROME_BRIDGE_RECORD_DIR || join(homedir(), '.config', 'chrome-bridge', 'recordings');

// Comandi rumore per un replay: letture interne (tabSnapshot) o senza effetto
const RECORD_EXCLUDE = new Set([MessageType.GET_TABS]);

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

/** Una riga (oggetto colonna→valore o array di celle) soddisfa il filtro where. */
function tableRowMatches(row, where) {
  return Object.entries(where).every(([col, needle]) => {
    const n = String(needle).toLowerCase();
    if (Array.isArray(row)) return row.some((cell) => String(cell).toLowerCase().includes(n));
    if (col === 'any') return Object.values(row).some((cell) => String(cell).toLowerCase().includes(n));
    const cell = row[col];
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
    truncated: (offset + page.length) < available || Boolean(data.truncated && !hasWhere),
    tables_found: data.tables_found ?? 0,
  };
  if (hasWhere) out.match_count = match_count;
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
async function applyWaitAfter(send, wait_after, tab_id) {
  if (wait_after === 'navigation') {
    return await send(MessageType.WAIT_FOR_NAVIGATION, { timeout: 15000, tab_id });
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
  audits: ['accessibility_audit', 'seo_audit', 'security_headers', 'check_links', 'unused_css', 'web_vitals', 'get_performance'],
  visual: ['screenshot_diff', 'highlight_elements', 'inject_css', 'measure_spacing', 'emulate_media', 'viewport_resize', 'set_zoom'],
  network: ['network_rules', 'monitor_websocket', 'http_auth', 'set_geolocation'],
  storage: ['get_storage', 'set_storage', 'session_fixture'],
  dom: ['modify_dom', 'watch_dom', 'list_event_listeners', 'drag_and_drop'],
  files: ['save_page', 'manage_downloads', 'extract_table', 'session_record'],
};

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
  accessibility_audit: ro(),
  assert: ro(),
  check_links: ro(true),
  element_screenshot: ro(),
  extract: ro(),
  extract_table: ro(),
  find_text: ro(),
  full_page_screenshot: ro(),
  get_frames: ro(),
  get_interactives: ro(),
  get_page_info: ro(),
  get_performance: ro(),
  get_status: ro(),
  get_storage: ro(),
  get_tabs: ro(),
  list_event_listeners: ro(),
  manage_downloads: ro(),
  measure_spacing: ro(),
  monitor_network: ro(true),
  monitor_websocket: ro(true),
  query_dom: ro(),
  read_page: ro(),
  screenshot: ro(),
  security_headers: ro(true),
  seo_audit: ro(),
  unused_css: ro(),
  wait_for: ro(),
  watch_dom: ro(),
  web_vitals: ro(),

  // --- interazione con la pagina ---
  click: rw({ open: true }),          // un click può navigare
  drag_and_drop: rw(),
  fill_form: rw({ idempotent: true }),
  hover: rw({ idempotent: true }),
  press_key: rw(),
  scroll: rw(),
  type_text: rw({ idempotent: true }),
  upload_file: rw(),

  // --- modifica di pagina, tab o resa ---
  dismiss_overlays: rw({ idempotent: true }),
  emulate_media: rw({ idempotent: true }),
  handle_dialogs: rw({ idempotent: true }),
  highlight_elements: rw({ idempotent: true }),
  inject_css: rw({ idempotent: true }),
  modify_dom: rw({ idempotent: true }),
  screenshot_diff: rw({ idempotent: true }),
  set_zoom: rw({ idempotent: true }),
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
 */
export function registerTools(server, wsManager, caps = 'all') {
  const startedAt = Date.now();
  const activeCaps = caps === 'all'
    ? ['core', ...Object.keys(TOOL_CAPS)]
    : ['core', ...String(caps).split(',').map((s) => s.trim()).filter((s) => s && s !== 'core')];

  // Ogni registrazione passa da qui: il filtro capability scarta i tool opt-in
  // fuori dai gruppi attivi, e le annotations vengono applicate da TOOL_ANNOTATIONS.
  // Un solo wrapper per entrambe le cose, altrimenti con caps != 'all' le
  // annotations sparivano insieme al filtro.
  {
    const target = server;
    const enabled = caps !== 'all'
      ? new Set(String(caps).split(',').map((s) => s.trim()).filter(Boolean))
      : null;
    server = {
      tool(name, desc, schema, handler) {
        if (enabled) {
          const group = TOOL_TO_CAP.get(name);
          if (group && !enabled.has(group) && !enabled.has('all')) return;
        }
        const annotations = TOOL_ANNOTATIONS[name];
        // Un tool senza voce resta registrato (meglio di un crash all'avvio):
        // è il test tool-annotations a segnalarlo.
        if (annotations) target.tool(name, desc, schema, annotations, handler);
        else target.tool(name, desc, schema, handler);
      },
    };
  }

  // Ultimo tab toccato da navigate/create_tab in questa sessione: è il default
  // dei comandi senza tab_id esplicito. "Tab attivo" è una landmine quando
  // l'utente usa Chrome durante l'automazione (il comando colpirebbe la pagina
  // che sta guardando lui, non quella navigata dall'agente).
  let sessionTabId = null;

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

  // Mappa ref → selector per tab, popolata da get_interactives.
  // Permette click/type_text/hover per ref (n1, n2…) senza ripetere selettori lunghi.
  const interactivesRefs = new Map();

  const refsKey = (tab_id) => tab_id ?? sessionTabId ?? 'active';

  function resolveTarget(selector, ref, tab_id) {
    if (selector) return selector;
    if (ref) {
      const sel = interactivesRefs.get(refsKey(tab_id))?.get(ref);
      if (!sel) throw new Error(`Unknown ref ${ref} — run get_interactives first`);
      return sel;
    }
    throw new Error('Either selector or ref is required');
  }

  // Snapshot url/title del tab target, per il delta post-azione.
  async function tabSnapshot(tab_id) {
    try {
      const tabs = await send(MessageType.GET_TABS);
      const list = Array.isArray(tabs) ? tabs : [];
      const eff = tab_id ?? sessionTabId;
      const tab = eff != null ? list.find((t) => t.id === eff) : list.find((t) => t.active);
      return tab ? { url: tab.url, title: tab.title } : null;
    } catch { return null; }
  }

  // Delta compatto dopo un'azione: presente solo se url/title sono cambiati.
  // Costa pochi token quando scatta, zero quando la pagina è stabile, e
  // risparmia al client un giro di ispezione per capire "cosa è successo".
  function pageDelta(before, after) {
    if (!before || !after) return null;
    const delta = {};
    if (after.url !== before.url) delta.url = after.url;
    if (after.title !== before.title) delta.title = after.title;
    return Object.keys(delta).length ? delta : null;
  }

  // Anteprima compatta dei primi interactives (con ref), allegata a navigate:
  // il client può agire subito senza un giro di discovery. Cappata e best-effort.
  async function interactivesPreview(tab_id, limit = 12) {
    try {
      const data = await send(MessageType.GET_INTERACTIVES, { limit, visible_only: true, tab_id });
      const refMap = new Map();
      (data?.elements ?? []).forEach((e, i) => {
        e.ref = `n${i + 1}`;
        if (e.selector) refMap.set(e.ref, e.selector);
      });
      interactivesRefs.set(refsKey(tab_id), refMap);
      return refMap.size ? truncateText(interactivesLines(data), 1500) : null;
    } catch { return null; }
  }

  // --- get_status ---
  server.tool(
    'get_status',
    'Check bridge status: extension connection, server mode (primary/relay), port, version',
    {},
    async () => {
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
            // Un agente che non trova accessibility_audit non aveva modo di
            // scoprire che esiste ma è in un gruppo disattivato.
            caps_active: activeCaps,
            caps_available: ['core', ...Object.keys(TOOL_CAPS)],
            session_tab_id: sessionTabId,
            uptime_sec: Math.round((Date.now() - startedAt) / 1000),
          }),
        }],
      };
    }
  );

  // --- get_tabs ---
  server.tool(
    'get_tabs',
    'List every open tab with id, url, title and active flag. Read-only. Use it to find a tab_id when the '
      + 'implicit target (last navigated tab, else the active one) is not the tab you mean. '
      + 'include_windows adds the windows themselves with their position, size, state and type — what you need '
      + 'before moving or tiling anything, and the only way to tell which monitor a window is on.',
    {
      include_windows: z.boolean().optional().default(false)
        .describe('Also return the windows with bounds, state, type and tab count'),
    },
    async ({ include_windows }) => {
      const data = await send(MessageType.GET_TABS, { include_windows: include_windows === true });
      return {
        content: [{
          type: 'text',
          text: jsonText(data),
        }],
      };
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
      const data = await send(MessageType.NAVIGATE, { url, tab_id });
      // Il tab navigato diventa il default di sessione per i comandi successivi
      if (data?.tabId != null) sessionTabId = data.tabId;
      const preview = await interactivesPreview(data?.tabId ?? tab_id);
      return {
        content: [{
          type: 'text',
          text: jsonText(data) + (preview ? `\n${preview}` : ''),
        }],
      };
    }
  );

  // --- screenshot ---
  server.tool(
    'screenshot',
    'Screenshot of the visible viewport only (PNG), at the current scroll position. Read-only. '
      + 'Activates the tab in the background without stealing window focus, then restores the previous tab. '
      + 'Downscaled to ≤1568px, so fine print may not survive.',
    {
      tab_id: tabId,
      save_to: saveToField('the PNG'),
    },
    async ({ tab_id, save_to }) => {
      const data = await send(MessageType.SCREENSHOT, { tab_id });
      const b64 = data?.image ?? data?.data;
      if (save_to && b64) return savedSummary(save_to, Buffer.from(b64, 'base64'), { mimeType: 'image/png' });
      // data.image è base64 PNG
      if (data && data.image) {
        return {
          content: [{
            type: 'image',
            data: data.image,
            mimeType: 'image/png',
          }],
        };
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
    'Run JavaScript in the page (MAIN world). Requires the extension\'s "Allow user scripts" toggle; errors explain setup if disabled.',
    {
      code:       z.string().describe('JS evaluated in the page; the value of the last expression is returned'),
      tab_id:     tabId,
      frame_id:   frameId,
      max_length: z.number().optional().default(20000).describe('Max output chars'),
    },
    async ({ code, tab_id, frame_id, max_length }) => {
      const data = await send(MessageType.EXECUTE_JS, { code, tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: truncateText(JSON.stringify(data), max_length ?? DEFAULT_MAX_OUTPUT, 'max_length'),
        }],
      };
    }
  );

  // --- click ---
  server.tool(
    'click',
    'Click an element, by CSS selector or by a ref (n1, n2…) from get_interactives or navigate. Fires a real '
      + 'pointer sequence, so it can submit, open a dialog or navigate away — use wait_after to let that settle. '
      + 'Not idempotent, and a click that triggers a native confirm() blocks the bridge: install handle_dialogs first.',
    {
      selector: z.string().optional().describe('CSS selector; ">>>" pierces shadow DOM. Ignored when ref is given'),
      ref:      z.string().optional().describe('From get_interactives, e.g. "n3"'),
      force:    z.boolean().optional().default(false).describe('Click even if occluded'),
      button:   z.enum(['left', 'right']).optional().default('left').describe('right opens the page context menu instead of activating the element'),
      count:    z.number().optional().default(1).describe('2 emits dblclick after the two clicks, which is what selects a word or opens an editor'),
      wait_after: waitAfter,
      tab_id:   tabId,
      frame_id: frameId,
    },
    async ({ selector, ref, force, button, count, wait_after, tab_id, frame_id }) => {
      const target = resolveTarget(selector, ref, tab_id);
      const before = await tabSnapshot(tab_id);
      const data = await send(MessageType.CLICK, { selector: target, force, button: button ?? 'left', count: count ?? 1, frame_id, tab_id });
      // Niente attesa se il click non è andato a buon fine (es. elemento occluso)
      const waited = data?.occluded ? null : await applyWaitAfter(send, wait_after, tab_id);
      const changed = data?.occluded ? null : pageDelta(before, await tabSnapshot(tab_id));
      const out = { ...data, ...(waited && { wait_after: waited }), ...(changed && { page_changed: changed }) };
      return {
        content: [{
          type: 'text',
          text: jsonText(out),
        }],
      };
    }
  );

  // --- type_text ---
  server.tool(
    'type_text',
    'Put text into an input, textarea or contenteditable, by CSS selector or by a ref from get_interactives. '
      + 'Replaces the whole value rather than appending, and assigns through the native setter so React and '
      + 'Vue controlled inputs register the change, then fires input and change. mode=keys instead emits '
      + 'keydown/input/keyup per character, which is what autocomplete and masked fields need — slower, so '
      + 'reach for it only when mode=set leaves the field empty or the dropdown never opens.',
    {
      selector: z.string().optional().describe('CSS selector; ">>>" pierces shadow DOM. Ignored when ref is given'),
      ref:      z.string().optional().describe('From get_interactives, e.g. "n3"'),
      text:     z.string().describe('Value to type; empty string clears the field'),
      mode:     z.enum(['set', 'keys']).optional().default('set').describe('set = assign value; keys = per-char events (autocomplete/masked)'),
      wait_after: waitAfter,
      tab_id:   tabId,
      frame_id: frameId,
    },
    async ({ selector, ref, text, mode, wait_after, tab_id, frame_id }) => {
      const target = resolveTarget(selector, ref, tab_id);
      const data = await send(MessageType.TYPE_TEXT, { selector: target, text, mode, tab_id, frame_id });
      const waited = await applyWaitAfter(send, wait_after, tab_id);
      const out = waited ? { ...data, wait_after: waited } : data;
      return {
        content: [{
          type: 'text',
          text: jsonText(out),
        }],
      };
    }
  );

  // --- read_page ---
  server.tool(
    'read_page',
    'Read the page as text (default), markdown, raw HTML, or accessibility tree. Read-only. markdown keeps '
      + 'headings, links and tables at a fraction of the HTML cost, and is usually the right middle ground. '
      + 'Expensive on large pages: '
      + 'HTML on a big table costs tens of thousands of tokens for data you then filter anyway — prefer '
      + 'extract_table or extract for tabular and repeated content, and get_interactives to find click targets.',
    {
      mode:       z.enum(['text', 'markdown', 'html', 'accessibility']).default('text').describe('text strips markup, markdown keeps headings/links/tables far cheaper than html, accessibility returns the a11y tree'),
      tab_id:     tabId,
      frame_id:   frameId,
      max_length: z.number().optional().default(50000).describe('Max output chars'),
      save_to:    saveToField('the page'),
    },
    async ({ mode, tab_id, frame_id, max_length, save_to }) => {
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
    'Get page metadata: meta tags, scripts, stylesheets, links, and forms',
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

  // --- get_performance ---
  server.tool(
    'get_performance',
    'Navigation timing, paint metrics, JS heap size and per-resource load times, as measured since the current '
      + 'document loaded. Read-only, no reload triggered — numbers are only meaningful once loading has settled, '
      + 'so on a page still fetching wait for network idle first. Covers how fast the document arrived, '
      + 'not the layout-shift and interaction metrics that accumulate afterwards.',
    {
      tab_id: tabId,
    },
    async ({ tab_id }) => {
      const data = await send(MessageType.GET_PERFORMANCE, { tab_id });
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
      tab_id: tabId,
    },
    async ({ clear, level, limit, format, tab_id }) => {
      // limit va all'estensione: taglia in pagina e cancella (con clear) solo
      // ciò che ha restituito. Lo slice qui resta come fallback per estensioni
      // più vecchie che ignorano il parametro.
      const data = await send(MessageType.READ_CONSOLE, { clear, level, limit, tab_id });
      const all = data?.messages ?? [];
      const tail = all.slice(-(limit ?? 50));
      const total = data?.count ?? all.length;
      const note = data?.note;
      if ((format ?? 'lines') === 'json') {
        return { content: [{ type: 'text', text: jsonText({ total, shown: tail.length, ...(note ? { note } : {}), messages: tail }) }] };
      }
      return {
        content: [{
          type: 'text',
          text: truncateText(
            (note ? `note=${note}\n` : '') + consoleLines(tail, total),
            DEFAULT_MAX_OUTPUT,
          ),
        }],
      };
    }
  );

  // --- monitor_network ---
  server.tool(
    'monitor_network',
    'Monitor network requests. source=page: XHR/fetch hook (installed on first call); source=browser: all requests incl. static assets. format=har exports HAR 1.2.',
    {
      clear: z.boolean().optional().default(false).describe('Clear buffer after read'),
      source: z.enum(['page', 'browser']).optional().default('page').describe('page sees XHR/fetch only; browser also sees static assets'),
      format: z.enum(['lines', 'json', 'har']).optional().default('lines').describe('har exports HAR 1.2 for external tooling'),
      limit: z.number().optional().default(100).describe('Most recent; buffer 1000'),
      tab_id: tabId,
    },
    async ({ clear, source, format, limit, tab_id }) => {
      // limit va all'estensione (taglia in pagina, clear solo del restituito);
      // lo slice qui resta come fallback per estensioni non ancora aggiornate.
      const data = await send(MessageType.MONITOR_NETWORK, { clear, source, limit, tab_id });
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
          ),
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
      if (data?.id != null) sessionTabId = data.id;
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
    'Block until a condition holds: element (selector in the DOM), function (JS expression turns truthy; needs '
      + 'the "Allow user scripts" toggle), navigation (mode=spa for client-side route changes), network_idle. '
      + 'Polls until timeout — 10s for element and function, 15s for navigation and network_idle — then '
      + '**returns `found: false` with a reason instead of raising**, so a caller that ignores the result '
      + 'silently proceeds as if the wait had succeeded. Read-only: waiting changes nothing on the page.',
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
      tab_id: tabId,
      frame_id: frameId,
    },
    async ({ action, selector, x, y, behavior, offset_y, until, max_scrolls, step_px, settle_ms, tab_id, frame_id }) => {
      const data = (action ?? 'to') === 'until'
        ? await send(MessageType.SCROLL_UNTIL, { until, selector, max_scrolls, step_px, settle_ms, tab_id })
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
    'Batch fill form fields with React-compatible events. Handles input, select, checkbox, radio, and textarea.',
    {
      fields: z.array(z.object({
        selector: z.string(),
        value: z.string(),
      })).describe('{selector, value} pairs'),
      submit_selector: z.string().optional().describe('Submit button to click after filling'),
      wait_after: waitAfter,
      tab_id: tabId,
      frame_id: frameId,
    },
    async ({ fields, submit_selector, wait_after, tab_id, frame_id }) => {
      const before = await tabSnapshot(tab_id);
      const data = await send(MessageType.FILL_FORM, { fields, submit_selector, tab_id, frame_id });
      const waited = await applyWaitAfter(send, wait_after, tab_id);
      const changed = pageDelta(before, await tabSnapshot(tab_id));
      const out = { ...data, ...(waited && { wait_after: waited }), ...(changed && { page_changed: changed }) };
      return {
        content: [{
          type: 'text',
          text: jsonText(out),
        }],
      };
    }
  );

  // --- viewport_resize ---
  server.tool(
    'viewport_resize',
    'Resize the Chrome **window** to a preset (mobile 375x812, tablet 768x1024, desktop 1440x900) or to explicit '
      + 'dimensions. The rendered viewport ends up smaller than what you ask for, by the height of the browser '
      + 'chrome — measure it with execute_js if the exact number matters. width and height each override the '
      + 'corresponding half of the preset, so preset plus width gives a custom width at the preset height. '
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
      tab_id: tabId,
    },
    async ({ action, preset, width, height, left, top, state, tab_id }) => {
      const data = await send(MessageType.VIEWPORT_RESIZE, { preset, width, height, left, top, state, read_only: (action ?? 'set') === 'get', tab_id });
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
    'Screenshot cropped to one element (PNG), scrolled into view first. Read-only. '
      + 'The cheapest image in the set, because it carries only the box you asked for: '
      + 'a component, a chart, a table cell.',
    {
      selector: z.string().describe('CSS selector; ">>>" pierces shadow DOM. The element is scrolled into view first'),
      tab_id: tabId,
    },
    async ({ selector, tab_id }) => {
      const data = await send(MessageType.ELEMENT_SCREENSHOT, { selector, tab_id });
      if (data && data.image) {
        return { content: [{ type: 'image', data: data.image, mimeType: 'image/png' }] };
      }
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- full_page_screenshot ---
  server.tool(
    'full_page_screenshot',
    'Full-page capture by scrolling: stitched segments of ~2 viewports (≤1568px, top→bottom), or one image per '
      + 'viewport with stitch=false. Read-only, but expensive: each segment costs ~2.7k image tokens, so only the first '
      + 'max_segments are returned and the rest need segment_offset. On a long page, reading the text you actually need '
      + 'is cheaper by an order of magnitude — prefer read_page, extract or find_text unless the layout itself is the question.',
    {
      max_scrolls: z.number().optional().default(20).describe('Cap on scroll steps: a taller page is captured only up to here'),
      delay: z.number().optional().default(500).describe('ms between captures (min 500, Chrome quota)'),
      stitch: z.boolean().optional().default(true).describe('false = one image per viewport'),
      max_segments: z.number().optional().default(3).describe('Images returned, from the top (each ≈2.7k image tokens); raise or use segment_offset for the rest'),
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

  // --- highlight_elements ---
  server.tool(
    'highlight_elements',
    'Outline every element matching a selector with a coloured overlay, to see on a screenshot what a selector '
      + 'actually caught. Each call clears the overlays left by the previous one instead of stacking them, and '
      + 'remove=true clears without adding. The overlays are injected DOM nodes: a reload or a navigation drops '
      + 'them, and they sit above the page without altering its layout or its own styles.',
    {
      selector: z.string().optional().describe('CSS selector; ">>>" pierces shadow DOM. Every match is outlined'),
      color: z.string().optional().default('rgba(255,0,0,0.3)').describe('Any CSS color for the overlay label'),
      border: z.string().optional().default('2px solid red').describe('CSS border shorthand, e.g. "2px solid red"'),
      label: z.boolean().optional().default(false).describe('Show tag.class (WxH) label'),
      remove: z.boolean().optional().default(false).describe('Remove previously injected highlights instead of adding'),
      tab_id: tabId,
    },
    async ({ selector, color, border, label, remove, tab_id }) => {
      const data = await send(MessageType.HIGHLIGHT_ELEMENTS, { selector, color, border, label, remove, tab_id });
      return {
        content: [{
          type: 'text',
          text: jsonText(data),
        }],
      };
    }
  );

  // --- accessibility_audit ---
  server.tool(
    'accessibility_audit',
    'A11y audit: missing alt, empty links, heading hierarchy, ARIA, contrast (approximate), form labels.',
    {
      scope: z.string().optional().describe('Limit scope (CSS selector)'),
      checks: z.array(z.enum(['images', 'links', 'headings', 'aria', 'contrast', 'forms', 'all'])).optional().default(['all']).describe('Subset to run; fewer checks means a shorter answer'),
      tab_id: tabId,
    },
    async ({ scope, checks, tab_id }) => {
      const data = await send(MessageType.ACCESSIBILITY_AUDIT, { scope, checks, tab_id });
      return {
        content: [{
          type: 'text',
          text: jsonText(data),
        }],
      };
    }
  );

  // --- check_links ---
  server.tool(
    'check_links',
    'Check page links for broken URLs, verified server-side (no CORS limits, real HTTP status).',
    {
      scope: z.enum(['same-origin', 'all', 'external']).optional().default('all').describe('same-origin skips third-party links, which are the slow ones'),
      selector: z.string().optional().default('a[href]').describe('CSS selector; ">>>" pierces shadow DOM. Restricts which links are collected'),
      timeout: z.number().optional().default(5000).describe('Per-link ms'),
      max_links: z.number().optional().default(50).describe('Cap on links fetched: each one is a real HTTP request'),
      format: z.enum(['lines', 'json']).optional().default('lines').describe('lines is compact; json keeps per-link status and timing'),
      tab_id: tabId,
    },
    async ({ scope, selector, timeout, max_links, format, tab_id }) => {
      const data = await send(MessageType.COLLECT_LINKS, { scope, selector, max_links, tab_id });
      const links = data.links ?? [];
      const results = await checkLinksBatch(links, timeout);
      const broken = results.filter((r) => r.broken).length;
      if ((format ?? 'lines') === 'json') {
        return {
          content: [{
            type: 'text',
            text: jsonText({ total: links.length, checked: results.length, broken, totalAnchors: data.totalAnchors, results }),
          }],
        };
      }
      return {
        content: [{
          type: 'text',
          text: truncateText(linksLines(results, { total: links.length, broken, anchors: data.totalAnchors }), DEFAULT_MAX_OUTPUT),
        }],
      };
    }
  );

  // --- measure_spacing ---
  server.tool(
    'measure_spacing',
    'Measure the gap, overlap and distance in CSS pixels between two elements, with their margins and paddings. '
      + 'Read-only. Values come from the current layout, so zoom and viewport size change them: set_zoom(1) and a '
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
    'Make the page believe it runs in a different environment, until reset or reload: prefers-color-scheme, '
      + 'prefers-reduced-motion, print mode (matchMedia override + CSS) and navigator.userAgent/platform. '
      + 'user_agent only changes what page JS reads — the request header is a separate thing, set it with '
      + 'network_rules(action=modify_header, header="User-Agent"). Pair with viewport_resize to emulate a device.',
    {
      colorScheme: z.enum(['dark', 'light', 'no-preference']).optional().describe('Value reported to prefers-color-scheme queries'),
      reducedMotion: z.enum(['reduce', 'no-preference']).optional().describe('Value reported to prefers-reduced-motion queries'),
      printMode: z.boolean().optional().default(false).describe('Make print media queries match, without opening a print dialog'),
      user_agent: z.string().optional().describe('Overrides navigator.userAgent and appVersion in the page (not the HTTP header)'),
      reset: z.boolean().optional().default(false).describe('Remove all emulations'),
      tab_id: tabId,
    },
    async ({ colorScheme, reducedMotion, printMode, user_agent, reset, tab_id }) => {
      const data = await send(MessageType.EMULATE_MEDIA, { colorScheme, reducedMotion, printMode, user_agent, reset, tab_id });
      return {
        content: [{
          type: 'text',
          text: jsonText(data),
        }],
      };
    }
  );

  // --- hover ---
  server.tool(
    'hover',
    'Hover over an element (mouseenter/mouseover), by CSS selector or ref.',
    {
      selector: z.string().optional().describe('CSS selector; ">>>" pierces shadow DOM. Triggers CSS and JS hover handlers'),
      ref: z.string().optional().describe('From get_interactives'),
      tab_id: tabId,
      frame_id: frameId,
    },
    async ({ selector, ref, tab_id, frame_id }) => {
      const data = await send(MessageType.HOVER, { selector: resolveTarget(selector, ref, tab_id), tab_id, frame_id });
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
      + 'arrows and shortcuts. Not idempotent: two calls send the key twice.',
    {
      key: z.string().describe('e.g. "Enter", "Escape", "Tab", "ArrowDown"'),
      selector: z.string().optional().describe('Target (default: activeElement)'),
      ctrl: z.boolean().optional().default(false).describe('Hold Control'),
      shift: z.boolean().optional().default(false).describe('Hold Shift'),
      alt: z.boolean().optional().default(false).describe('Hold Alt'),
      meta: z.boolean().optional().default(false).describe('Hold Meta (Command/Windows)'),
      tab_id: tabId,
      frame_id: frameId,
    },
    async ({ key, selector, ctrl, shift, alt, meta, tab_id, frame_id }) => {
      const data = await send(MessageType.PRESS_KEY, { key, selector, ctrl, shift, alt, meta, tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: jsonText(data),
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
    'Tab lifecycle: close, activate (focus), reload (optional cache bypass), back, forward. close discards the '
      + 'tab and anything unsaved in it, and cannot be undone — it may be a tab the user is working in. '
      + 'reload and navigation drop injected CSS, emulations and page hooks.',
    {
      action: z.enum(['close', 'activate', 'reload', 'back', 'forward', 'discard', 'mute', 'unmute', 'duplicate']).describe('close cannot be undone; discard frees memory, the tab reloads on focus; reload drops injected CSS and hooks'),
      bypass_cache: z.boolean().optional().default(false).describe('reload only'),
      tab_id: tabId,
    },
    async ({ action, bypass_cache, tab_id }) => {
      const data = await send(MessageType.TAB_ACTION, { action, bypass_cache, tab_id });
      if (action === 'close' && (tab_id == null || tab_id === sessionTabId)) sessionTabId = null;
      if (action === 'activate' && tab_id != null) sessionTabId = tab_id;
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- upload_file ---
  server.tool(
    'upload_file',
    'Set a file on input[type=file] from the server filesystem via DataTransfer (max 10MB).',
    {
      selector: z.string().describe('The file input to fill; ">>>" pierces shadow DOM'),
      path: z.string().describe('Absolute path on the server machine'),
      mime_type: z.string().optional().describe('Default: inferred from extension'),
      tab_id: tabId,
    },
    async ({ selector, path, mime_type, tab_id }) => {
      const buf = await readFile(path);
      if (buf.length > 10 * 1024 * 1024) throw new Error(`File too large: ${buf.length} bytes (max 10MB)`);
      const mime = mime_type || MIME_BY_EXT[extname(path).toLowerCase()] || 'application/octet-stream';
      const data = await send(MessageType.UPLOAD_FILE, {
        selector, name: basename(path), mime_type: mime, content_b64: buf.toString('base64'), tab_id,
      });
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
            const refMap = new Map();
            els.forEach((e, i) => {
              e.ref = `n${i + 1}`;
              if (e.selector) refMap.set(e.ref, e.selector);
            });
            interactivesRefs.set(refsKey(tab_id), refMap);
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
    'Network interception, browser-wide, survives reloads until cleared: block requests, redirect URLs, set/remove request headers, or stub responses with a synthetic body (served by a local helper; from HTTPS pages the stub host must be trustworthy).',
    {
      action: z.enum(['block', 'redirect', 'modify_header', 'stub', 'list', 'clear']).describe('list and clear inspect and drop the rules already installed'),
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
    async ({ action, url_filter, redirect_url, header, header_value, header_target, body, status, content_type, resource_types }) => {
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
    'Visual regression: save a named baseline (viewport or element), compare later — returns changed-pixel % and red-highlighted diff image. Baselines are in-memory (lost on service worker restart).',
    {
      action: z.enum(['baseline', 'compare', 'list', 'clear']).describe('baseline stores, compare measures against it, clear drops baselines'),
      name: z.string().optional().default('default').describe('Baseline id: reuse the same one to compare across runs'),
      selector: z.string().optional().describe('Capture one element (default viewport)'),
      threshold: z.number().optional().default(10).describe('Per-channel tolerance 0-255'),
      tab_id: tabId,
    },
    async ({ action, name, selector, threshold, tab_id }) => {
      const data = await send(MessageType.SCREENSHOT_DIFF, { action, name, selector, threshold, tab_id });
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

  // --- web_vitals ---
  server.tool(
    'web_vitals',
    'Core Web Vitals accumulated since the current document loaded: CLS, LCP, FCP, TTFB, long tasks and an INP '
      + 'approximation. Read-only. Needs the page instrumentation active from before load, so it reports whether it '
      + 'was hooked instead of silently returning zeros — navigate() installs it. '
      + 'Covers user-perceived stability and responsiveness after load, not the load timings themselves.',
    {
      tab_id: tabId,
    },
    async ({ tab_id }) => {
      const data = await send(MessageType.WEB_VITALS, { tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- list_event_listeners ---
  server.tool(
    'list_event_listeners',
    'List addEventListener registrations since page load: counts by type + recent entries.',
    {
      type: z.string().optional().describe('e.g. "click"'),
      limit: z.number().optional().default(100).describe('Max listeners returned, from the top of the match list'),
      tab_id: tabId,
    },
    async ({ type, limit, tab_id }) => {
      const data = await send(MessageType.LIST_EVENT_LISTENERS, { type, limit, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- monitor_websocket ---
  server.tool(
    'monitor_websocket',
    'Monitor WebSocket connections/messages (500-char previews). Hook installs on first call; earlier connections are missed.',
    {
      clear: z.boolean().optional().default(false).describe('Clear buffer after read'),
      tab_id: tabId,
    },
    async ({ clear, tab_id }) => {
      const data = await send(MessageType.MONITOR_WEBSOCKET, { clear, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- seo_audit ---
  server.tool(
    'seo_audit',
    'SEO audit: title/description lengths, canonical, robots, h1 count, Open Graph, Twitter card, JSON-LD validity, hreflang, lang, viewport, favicon',
    {
      tab_id: tabId,
    },
    async ({ tab_id }) => {
      const data = await send(MessageType.SEO_AUDIT, { tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
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
      where: z.record(z.string(), z.string()).optional().describe('{column: substring} rows must match, case-insensitive contains. Key "any" matches any cell.'),
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

  // --- unused_css ---
  server.tool(
    'unused_css',
    'List CSS selectors matching nothing in the current DOM (approximate; cross-origin sheets unreadable).',
    {
      max_selectors: z.number().optional().default(200).describe('Cap on unused selectors reported: a large stylesheet has thousands'),
      tab_id: tabId,
    },
    async ({ max_selectors, tab_id }) => {
      const data = await send(MessageType.UNUSED_CSS, { max_selectors, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
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
    'Read or write the system clipboard (text). Activates the tab first.',
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
    'List downloads or wait for one to complete. Files land in the browser Downloads folder, not on the server.',
    {
      action: z.enum(['list', 'wait_for_complete', 'download']).describe('download starts one with the browser cookie jar; wait_for_complete blocks until the newest finishes'),
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
      const data = await send(MessageType.SAVE_PAGE, { tab_id });
      await writeFile(output_path, Buffer.from(data.mhtml_b64, 'base64'));
      return { content: [{ type: 'text', text: jsonText({ saved: output_path, size: data.size }) }] };
    }
  );

  // --- http_request ---
  server.tool(
    'http_request',
    'HTTP request sent from the browser, so it carries the session cookies of the logged-in user: '
      + 'fetches URLs a plain server-side request would get a login page for (invoices, authenticated JSON, CSV exports). '
      + 'Text bodies are returned inline (capped by max_length); with save_to the bytes are written to that path instead, '
      + 'which is how you read a PDF — Chrome renders PDFs in a viewer no content script can reach, so read_page returns nothing on a PDF tab.',
    {
      url: z.string().describe('Absolute URL. Cookies are sent for its origin'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional().default('GET').describe('HEAD fetches headers only, without the body'),
      headers: z.record(z.string(), z.string()).optional().describe('Extra request headers'),
      body: z.string().optional().describe('Request body (POST/PUT/PATCH)'),
      save_to: z.string().optional().describe('Absolute path: write the response bytes here instead of returning them (PDF, images, archives)'),
      max_length: z.number().optional().default(DEFAULT_MAX_OUTPUT).describe('Max chars of body returned inline'),
    },
    async ({ url, method, headers, body, save_to, max_length }) => {
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
    'Move an existing tab into another window (chrome.tabs.move), e.g. to consolidate windows that were '
      + 'each opened separately. Does not create or close anything: the tab keeps its id, its history and its '
      + 'page state. Both windows must be normal browser windows — Chrome refuses to move a tab into a popup or '
      + 'an app window, and the refusal is reported verbatim rather than retried.',
    {
      tab_id: z.number().describe('Tab to move; get it from get_tabs'),
      window_id: z.number().optional().describe('Destination window; get_tabs reports windowId for every tab'),
      new_window: z.boolean().optional().default(false).describe('Extract the tab into a fresh window instead — tabs.move needs an existing window, this does not'),
      left: z.number().optional().describe('New window x (new_window)'),
      top: z.number().optional().describe('New window y (new_window)'),
      width: z.number().optional().describe('New window width px (new_window)'),
      height: z.number().optional().describe('New window height px (new_window)'),
      index: z.number().optional().default(-1).describe('Position in the destination window; -1 appends at the end'),
    },
    async ({ tab_id, window_id, new_window, left, top, width, height, index }) => {
      if (window_id == null && new_window !== true) {
        throw new Error('Provide window_id (an existing window) or new_window: true');
      }
      const data = await send(MessageType.MOVE_TAB, { tab_id, window_id, new_window: new_window === true || undefined, left, top, width, height, index: index ?? -1 });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- tile_windows ---
  server.tool(
    'tile_windows',
    'Tile Chrome windows over one monitor, splitting its usable area into equal parts that leave no gap. '
      + 'Only Chrome windows: an extension cannot touch other applications. The monitor is chosen by pointing at '
      + 'a window already on it, since the work area is read from a page there — so at least one target window '
      + 'needs a scriptable tab (a chrome:// or chrome-untrusted:// tab cannot provide it). Maximized windows are '
      + 'restored first, because a maximized window accepts bounds and ignores them.',
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
    'Save the current window arrangement under a name, restore one, list or delete saved ones. save overwrites '
      + 'a same-named layout without asking. Window ids do not survive a browser restart, so restore recognises '
      + 'windows by the overlap of their tab URLs (same type required) and repositions the best match — windows '
      + 'it cannot recognise are reported, not guessed. Needs extension >= 1.14.0 for window geometry.',
    {
      action: z.enum(['save', 'restore', 'list', 'delete']).describe('save snapshots every window; restore repositions the recognised ones'),
      name: z.string().optional().describe('Layout name, required except for list'),
    },
    async ({ action, name }) => {
      const readLayouts = async () => {
        try { return JSON.parse(await readFile(LAYOUTS_FILE, 'utf8')); } catch { return {}; }
      };

      if (action === 'list') {
        const all = await readLayouts();
        const rows = Object.entries(all).map(([n, l]) => ({ name: n, windows: l.windows.length, savedAt: l.savedAt }));
        return { content: [{ type: 'text', text: jsonText({ layouts: rows }) }] };
      }

      if (!name || !/^[\w-]+$/.test(name)) throw new Error('name is required and must match [\\w-]+');

      if (action === 'delete') {
        const all = await readLayouts();
        const existed = Boolean(all[name]);
        delete all[name];
        await mkdir(dirname(LAYOUTS_FILE), { recursive: true });
        await writeFile(LAYOUTS_FILE, JSON.stringify(all, null, 2));
        return { content: [{ type: 'text', text: jsonText({ deleted: name, existed }) }] };
      }

      // save e restore hanno bisogno della fotografia corrente
      const snap = await send(MessageType.GET_TABS, { include_windows: true });
      if (Array.isArray(snap) || !snap?.windows) {
        // Un'estensione < 1.14.0 risponde con il solo array di schede: meglio
        // dirlo che fallire su una proprietà mancante.
        throw new Error('window_layout needs extension >= 1.14.0: get_tabs returned no window geometry');
      }
      const urlsByWindow = new Map();
      for (const t of snap.tabs || []) {
        if (!urlsByWindow.has(t.windowId)) urlsByWindow.set(t.windowId, []);
        urlsByWindow.get(t.windowId).push(t.url || '');
      }

      if (action === 'save') {
        const all = await readLayouts();
        all[name] = {
          savedAt: new Date().toISOString(),
          windows: snap.windows.map((w) => ({
            type: w.type,
            state: w.state,
            left: w.left, top: w.top, width: w.width, height: w.height,
            tabs: urlsByWindow.get(w.id) || [],
          })),
        };
        await mkdir(dirname(LAYOUTS_FILE), { recursive: true });
        await writeFile(LAYOUTS_FILE, JSON.stringify(all, null, 2));
        return { content: [{ type: 'text', text: jsonText({ saved: name, windows: all[name].windows.length }) }] };
      }

      // restore
      const all = await readLayouts();
      const layout = all[name];
      if (!layout) {
        throw new Error(`Layout "${name}" not found — saved: ${Object.keys(all).join(', ') || 'none'}`);
      }

      // Matching: sovrapposizione degli URL (Jaccard), a parità di tipo. Greedy
      // sulla coppia migliore. Gli id non entrano mai: non sopravvivono al
      // riavvio del browser.
      const current = snap.windows.map((w) => ({ ...w, urls: new Set(urlsByWindow.get(w.id) || []) }));
      const pairs = [];
      layout.windows.forEach((savedWin, si) => {
        current.forEach((cur, ci) => {
          if (savedWin.type !== cur.type) return;
          const savedUrls = new Set(savedWin.tabs);
          let shared = 0;
          for (const u of savedUrls) if (cur.urls.has(u)) shared += 1;
          const union = new Set([...savedUrls, ...cur.urls]).size || 1;
          const score = shared / union;
          if (score > 0) pairs.push({ si, ci, score });
        });
      });
      pairs.sort((a, b) => b.score - a.score);

      const usedSaved = new Set();
      const usedCurrent = new Set();
      const results = [];
      for (const { si, ci, score } of pairs) {
        if (usedSaved.has(si) || usedCurrent.has(ci)) continue;
        usedSaved.add(si); usedCurrent.add(ci);
        const savedWin = layout.windows[si];
        const cur = current[ci];
        const anyTab = (snap.tabs || []).find((t) => t.windowId === cur.id);
        if (!anyTab) { results.push({ window_id: cur.id, error: 'no tab to address the window with' }); continue; }
        // Una finestra da massimizzare riceve SOLO lo stato: i bounds verrebbero
        // accettati e ignorati, e il confronto richiesto/ottenuto mentirebbe.
        const params = savedWin.state === 'normal'
          ? { tab_id: anyTab.id, left: savedWin.left, top: savedWin.top, width: savedWin.width, height: savedWin.height, state: 'normal' }
          : { tab_id: anyTab.id, state: savedWin.state };
        try {
          const r = await send(MessageType.VIEWPORT_RESIZE, params);
          results.push({ window_id: cur.id, score: Number(score.toFixed(2)), requested: params, window: r?.window ?? r?.actual ?? null });
        } catch (e) {
          results.push({ window_id: cur.id, score: Number(score.toFixed(2)), error: e.message });
        }
      }

      const unmatchedSaved = layout.windows.filter((_, i) => !usedSaved.has(i)).length;
      const unmatchedCurrent = current.filter((_, i) => !usedCurrent.has(i)).map((w) => w.id);
      return {
        content: [{
          type: 'text',
          text: jsonText({
            restored: name,
            matched: results.length,
            unmatched_saved: unmatchedSaved,
            unmatched_current: unmatchedCurrent,
            results,
          }),
        }],
      };
    }
  );

  // --- set_zoom ---
  server.tool(
    'set_zoom',
    'Get or set tab zoom (0.25–5). No factor = read current; reset restores default.',
    {
      factor: z.number().optional().describe('1 = 100%'),
      reset: z.boolean().optional().default(false).describe('Restore the default zoom for this origin'),
      tab_id: tabId,
    },
    async ({ factor, reset, tab_id }) => {
      const data = await send(MessageType.SET_ZOOM, { factor, reset, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
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

  // --- security_headers ---
  server.tool(
    'security_headers',
    'Audit security headers (CSP, HSTS, XCTO, clickjacking, Referrer/Permissions-Policy, version leaks). Captured from real navigations — reload if unavailable.',
    {
      tab_id: tabId,
    },
    async ({ tab_id }) => {
      const data = await send(MessageType.GET_RESPONSE_HEADERS, { tab_id });
      if (!data.available) {
        return { content: [{ type: 'text', text: jsonText(data) }] };
      }
      const result = evaluateSecurityHeaders(data.headers, data.url);
      result.status = data.status;
      return { content: [{ type: 'text', text: jsonText(result) }] };
    }
  );

  // --- session_fixture ---
  server.tool(
    'session_fixture',
    'Snapshot localStorage, sessionStorage and cookies of the current origin into a named fixture on the server, '
      + 'restore one, or list what has been saved. A logged-in state is the usual reason. save overwrites a '
      + 'fixture of the same name without asking; restore writes entries on top of what is already there '
      + 'rather than clearing first, and refuses outright when the tab sits on a different origin than the '
      + 'one recorded — cookies would otherwise attach to the wrong site. name is required except for list.',
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
      for (const storageType of ['localStorage', 'sessionStorage']) {
        for (const [k, v] of Object.entries(fixture[storageType] || {})) {
          await send(MessageType.SET_STORAGE, { type: storageType, action: 'set', key: k, value: v, tab_id });
          restored[storageType]++;
        }
      }
      for (const c of fixture.cookies || []) {
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
      }
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
      frame_id: frameId,
      tab_id: tabId,
    },
    async ({ scope, limit, visible_only, format, frame_id, tab_id }) => {
      const data = await send(MessageType.GET_INTERACTIVES, { scope, limit, visible_only, frame_id, tab_id });
      // Assegna ref n1..nN e memorizza la mappa ref → selector per click/type_text/hover
      const refMap = new Map();
      (data?.elements ?? []).forEach((e, i) => {
        e.ref = `n${i + 1}`;
        if (e.selector) refMap.set(e.ref, e.selector);
      });
      interactivesRefs.set(refsKey(tab_id), refMap);
      if ((format ?? 'lines') === 'json') {
        return { content: [{ type: 'text', text: jsonText(data) }] };
      }
      return {
        content: [{
          type: 'text',
          text: truncateText(interactivesLines(data), DEFAULT_MAX_OUTPUT),
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
    'Record the commands of this session as a replayable jsonl file (replay with the CLI: chrome-bridge replay --file <path>). tab_id is stripped — replays target the tab they navigate.',
    {
      action: z.enum(['start', 'stop', 'status', 'list']).describe('start begins recording, stop writes the file and returns its path'),
      name: z.string().optional().describe('Required for start'),
    },
    async ({ action, name }) => {
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
      await recordChain; // il file deve essere completo quando il tool ritorna
      return { content: [{ type: 'text', text: jsonText(stopped ? { stopped: stopped.name, file: stopped.file } : { stopped: null }) }] };
    }
  );
}
