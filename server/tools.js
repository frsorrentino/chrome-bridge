/**
 * Registra i tool MCP sul server.
 *
 * Ogni tool crea un comando WebSocket, lo invia tramite il WSManager
 * e restituisce il risultato al client MCP.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { MessageType, VERSION } from './protocol.js';
import { checkLinksBatch } from './link-checker.js';
import { toHar } from './har.js';
import { evaluateSecurityHeaders } from './security-headers.js';
import { consoleLines, networkLines, interactivesLines, linksLines } from './formatters.js';

const SESSIONS_DIR = join(homedir(), '.config', 'chrome-bridge', 'sessions');

function truncateText(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated, ${text.length - max} more chars — use max_length to raise the limit]`;
}

// Limite di default sull'output testuale di ogni tool: protegge il contesto
// del client MCP da payload fuori scala (es. buffer console/network pieni).
const DEFAULT_MAX_OUTPUT = 20000;

/** Serializza compatto (niente pretty-print: solo token sprecati per il modello) e tronca. */
function jsonText(data, max = DEFAULT_MAX_OUTPUT) {
  return truncateText(JSON.stringify(data), max);
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
 * @param {import('./ws-manager.js').WSManager} wsManager - WebSocket manager
 * @param {'none'|'navigation'|'networkidle'} wait_after - tipo di attesa
 * @param {number} [tab_id] - tab target
 * @returns {Promise<object|null>} risultato dell'attesa, o null se none
 */
async function applyWaitAfter(wsManager, wait_after, tab_id) {
  if (wait_after === 'navigation') {
    return await wsManager.sendCommand(MessageType.WAIT_FOR_NAVIGATION, { timeout: 15000, tab_id });
  }
  if (wait_after === 'networkidle') {
    return await wsManager.sendCommand(MessageType.WAIT_FOR_NETWORK_IDLE, { idle_ms: 500, timeout: 15000, tab_id });
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
  files: ['save_page', 'manage_downloads', 'extract_table'],
};

const TOOL_TO_CAP = new Map();
for (const [group, names] of Object.entries(TOOL_CAPS)) {
  for (const n of names) TOOL_TO_CAP.set(n, group);
}

/**
 * Registra tutti i tool MCP.
 *
 * @param {import('@modelcontextprotocol/sdk/server/index.js').McpServer} server - MCP Server
 * @param {import('./ws-manager.js').WSManager} wsManager - WebSocket manager
 * @param {string} [caps='all'] - 'all', 'core', o lista di gruppi "audits,visual"
 */
export function registerTools(server, wsManager, caps = 'all') {
  const startedAt = Date.now();

  // Filtro capability: i tool opt-in fuori dai gruppi attivi non vengono registrati
  if (caps !== 'all') {
    const enabled = new Set(String(caps).split(',').map((s) => s.trim()).filter(Boolean));
    const target = server;
    server = {
      tool(name, desc, schema, handler) {
        const group = TOOL_TO_CAP.get(name);
        if (group && !enabled.has(group) && !enabled.has('all')) return;
        target.tool(name, desc, schema, handler);
      },
    };
  }

  // Mappa ref → selector per tab, popolata da get_interactives.
  // Permette click/type_text/hover per ref (n1, n2…) senza ripetere selettori lunghi.
  const interactivesRefs = new Map();

  const refsKey = (tab_id) => tab_id ?? 'active';

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
      const tabs = await wsManager.sendCommand(MessageType.GET_TABS);
      const list = Array.isArray(tabs) ? tabs : [];
      const tab = tab_id != null ? list.find((t) => t.id === tab_id) : list.find((t) => t.active);
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
      const data = await wsManager.sendCommand(MessageType.GET_INTERACTIVES, { limit, visible_only: true, tab_id });
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
            port: wsManager.port,
            version: VERSION,
            uptime_sec: Math.round((Date.now() - startedAt) / 1000),
          }),
        }],
      };
    }
  );

  // --- get_tabs ---
  server.tool(
    'get_tabs',
    'List all open Chrome tabs',
    {},
    async () => {
      const data = await wsManager.sendCommand(MessageType.GET_TABS);
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
      url:    z.string(),
      tab_id: z.number().optional(),
    },
    async ({ url, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.NAVIGATE, { url, tab_id });
      // Il tab della navigazione è il target giusto per la preview anche se
      // l'utente cambia tab attivo nel frattempo
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
    'Screenshot a tab (PNG). Activates the tab in the background without stealing window focus, then restores the previous tab.',
    {
      tab_id: z.number().optional(),
    },
    async ({ tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.SCREENSHOT, { tab_id });
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
      code:       z.string(),
      tab_id:     z.number().optional(),
      frame_id:   z.number().optional(),
      max_length: z.number().optional().default(20000).describe('Max output chars'),
    },
    async ({ code, tab_id, frame_id, max_length }) => {
      const data = await wsManager.sendCommand(MessageType.EXECUTE_JS, { code, tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: truncateText(JSON.stringify(data), max_length),
        }],
      };
    }
  );

  // --- click ---
  server.tool(
    'click',
    'Click an element by CSS selector or by ref from get_interactives.',
    {
      selector: z.string().optional(),
      ref:      z.string().optional().describe('From get_interactives, e.g. "n3"'),
      force:    z.boolean().optional().default(false).describe('Click even if occluded'),
      wait_after: z.enum(['none', 'navigation', 'networkidle']).optional().default('none'),
      tab_id:   z.number().optional(),
      frame_id: z.number().optional(),
    },
    async ({ selector, ref, force, wait_after, tab_id, frame_id }) => {
      const target = resolveTarget(selector, ref, tab_id);
      const before = await tabSnapshot(tab_id);
      const data = await wsManager.sendCommand(MessageType.CLICK, { selector: target, force, frame_id, tab_id });
      // Niente attesa se il click non è andato a buon fine (es. elemento occluso)
      const waited = data?.occluded ? null : await applyWaitAfter(wsManager, wait_after, tab_id);
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
    'Type text into an input, by CSS selector or by ref from get_interactives.',
    {
      selector: z.string().optional(),
      ref:      z.string().optional().describe('From get_interactives, e.g. "n3"'),
      text:     z.string(),
      mode:     z.enum(['set', 'keys']).optional().default('set').describe('set = assign value; keys = per-char events (autocomplete/masked)'),
      wait_after: z.enum(['none', 'navigation', 'networkidle']).optional().default('none'),
      tab_id:   z.number().optional(),
      frame_id: z.number().optional(),
    },
    async ({ selector, ref, text, mode, wait_after, tab_id, frame_id }) => {
      const target = resolveTarget(selector, ref, tab_id);
      const data = await wsManager.sendCommand(MessageType.TYPE_TEXT, { selector: target, text, mode, tab_id, frame_id });
      const waited = await applyWaitAfter(wsManager, wait_after, tab_id);
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
    'Read the content of a Chrome tab page',
    {
      mode:       z.enum(['text', 'html', 'accessibility']).default('text'),
      tab_id:     z.number().optional(),
      frame_id:   z.number().optional(),
      max_length: z.number().optional().default(50000).describe('Max output chars'),
    },
    async ({ mode, tab_id, frame_id, max_length }) => {
      const data = await wsManager.sendCommand(MessageType.READ_PAGE, { mode, tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: truncateText(typeof data === 'string' ? data : JSON.stringify(data), max_length),
        }],
      };
    }
  );

  // --- get_page_info ---
  server.tool(
    'get_page_info',
    'Get page metadata: meta tags, scripts, stylesheets, links, and forms',
    {
      tab_id: z.number().optional(),
      frame_id: z.number().optional(),
    },
    async ({ tab_id, frame_id }) => {
      const data = await wsManager.sendCommand(MessageType.GET_PAGE_INFO, { tab_id, frame_id });
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
    'Get page storage: localStorage, sessionStorage, and cookies',
    {
      type:   z.enum(['all', 'localStorage', 'sessionStorage', 'cookies']).default('all'),
      tab_id: z.number().optional(),
    },
    async ({ type, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.GET_STORAGE, { type, tab_id });
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
    'Get page performance metrics: navigation timing, paint metrics, memory, and resource loading',
    {
      tab_id: z.number().optional(),
    },
    async ({ tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.GET_PERFORMANCE, { tab_id });
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
      selector: z.string(),
      properties: z.array(z.string()).optional().describe('Computed styles to include, e.g. ["color"]'),
      limit: z.number().optional().default(50),
      tab_id: z.number().optional(),
      frame_id: z.number().optional(),
    },
    async ({ selector, properties, limit, tab_id, frame_id }) => {
      const data = await wsManager.sendCommand(MessageType.QUERY_DOM, { selector, properties, limit, tab_id, frame_id });
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
    'Modify DOM elements: setAttribute, removeAttribute, addClass, removeClass, setStyle, setTextContent',
    {
      selector: z.string(),
      action: z.enum(['setAttribute', 'removeAttribute', 'addClass', 'removeClass', 'setStyle', 'setTextContent']),
      name: z.string().optional().describe('Attribute name'),
      value: z.string().optional(),
      className: z.string().optional(),
      tab_id: z.number().optional(),
      frame_id: z.number().optional(),
    },
    async ({ selector, action, name, value, className, tab_id, frame_id }) => {
      const data = await wsManager.sendCommand(MessageType.MODIFY_DOM, { selector, action, name, value, className, tab_id, frame_id });
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
    'Inject CSS rules into a Chrome tab page',
    {
      css: z.string(),
      tab_id: z.number().optional(),
    },
    async ({ css, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.INJECT_CSS, { css, tab_id });
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
      level: z.enum(['all', 'log', 'warn', 'error', 'info', 'debug']).optional().default('all'),
      limit: z.number().optional().default(50).describe('Most recent; buffer 1000'),
      format: z.enum(['lines', 'json']).optional().default('lines'),
      tab_id: z.number().optional(),
    },
    async ({ clear, level, limit, format, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.READ_CONSOLE, { clear, level, tab_id });
      const all = data?.messages ?? [];
      const tail = all.slice(-(limit ?? 50));
      const total = data?.count ?? all.length;
      if ((format ?? 'lines') === 'json') {
        return { content: [{ type: 'text', text: jsonText({ total, shown: tail.length, messages: tail }) }] };
      }
      return {
        content: [{
          type: 'text',
          text: truncateText(consoleLines(tail, total), DEFAULT_MAX_OUTPUT),
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
      source: z.enum(['page', 'browser']).optional().default('page'),
      format: z.enum(['lines', 'json', 'har']).optional().default('lines'),
      limit: z.number().optional().default(100).describe('Most recent; buffer 1000'),
      tab_id: z.number().optional(),
    },
    async ({ clear, source, format, limit, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.MONITOR_NETWORK, { clear, source, tab_id });
      const { requests, count, ...rest } = data ?? {};
      const all = requests ?? [];
      const tail = all.slice(-(limit ?? 100));
      const total = count ?? all.length;
      const fmt = format ?? 'lines';
      if (fmt !== 'lines') {
        const out = fmt === 'har'
          ? toHar(tail)
          : { ...rest, total, shown: tail.length, requests: tail };
        return { content: [{ type: 'text', text: jsonText(out) }] };
      }
      return {
        content: [{
          type: 'text',
          text: truncateText(networkLines(tail, total), DEFAULT_MAX_OUTPUT),
        }],
      };
    }
  );

  // --- create_tab ---
  server.tool(
    'create_tab',
    'Create a new Chrome tab, optionally navigating to a URL',
    {
      url: z.string().optional().describe('URL to open (default: new tab page)'),
      active: z.boolean().optional().default(true),
    },
    async ({ url, active }) => {
      const data = await wsManager.sendCommand(MessageType.CREATE_TAB, { url, active });
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
    'Wait for: element (selector in DOM), function (JS expression truthy; needs "Allow user scripts"), navigation (mode=spa for route changes), network_idle.',
    {
      condition: z.enum(['element', 'function', 'navigation', 'network_idle']),
      selector: z.string().optional().describe('condition=element'),
      expression: z.string().optional().describe('JS expression (condition=function)'),
      visible: z.boolean().optional().default(false).describe('Element must also be visible'),
      mode: z.enum(['load', 'spa']).optional().default('load').describe('spa = pushState/popstate/hashchange'),
      idle_ms: z.number().optional().default(500).describe('Quiet period ms (network_idle)'),
      timeout: z.number().optional().describe('Max ms (default 10000; 15000 navigation/network_idle)'),
      interval: z.number().optional().describe('Poll ms, min 50'),
      tab_id: z.number().optional(),
      frame_id: z.number().optional(),
    },
    async ({ condition, selector, expression, visible, mode, idle_ms, timeout, interval, tab_id, frame_id }) => {
      let data;
      if (condition === 'element') {
        data = await wsManager.sendCommand(MessageType.WAIT_FOR_ELEMENT, {
          selector, timeout: timeout ?? 10000, interval: interval ?? 200, visible: visible ?? false, tab_id, frame_id,
        });
      } else if (condition === 'function') {
        data = await wsManager.sendCommand(MessageType.WAIT_FOR_FUNCTION, {
          expression, timeout: timeout ?? 10000, polling_ms: interval ?? 100, tab_id, frame_id,
        });
      } else if (condition === 'navigation') {
        data = await wsManager.sendCommand(MessageType.WAIT_FOR_NAVIGATION, {
          timeout: timeout ?? 15000, mode: mode ?? 'load', tab_id,
        });
      } else {
        data = await wsManager.sendCommand(MessageType.WAIT_FOR_NETWORK_IDLE, {
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
      action: z.enum(['to', 'until']).optional().default('to'),
      selector: z.string().optional().describe('Target (to) or stop element (until=element)'),
      x: z.number().optional(),
      y: z.number().optional(),
      behavior: z.enum(['smooth', 'instant', 'auto']).optional().default('auto'),
      offset_y: z.number().optional().default(0).describe('px offset for fixed headers (to)'),
      until: z.enum(['element', 'network_idle', 'no_new_content']).optional().default('no_new_content'),
      max_scrolls: z.number().optional().default(20),
      step_px: z.number().optional().describe('px per step, default viewport height'),
      settle_ms: z.number().optional().default(400).describe('Pause ms after each step'),
      tab_id: z.number().optional(),
      frame_id: z.number().optional().describe('action=to only'),
    },
    async ({ action, selector, x, y, behavior, offset_y, until, max_scrolls, step_px, settle_ms, tab_id, frame_id }) => {
      const data = (action ?? 'to') === 'until'
        ? await wsManager.sendCommand(MessageType.SCROLL_UNTIL, { until, selector, max_scrolls, step_px, settle_ms, tab_id })
        : await wsManager.sendCommand(MessageType.SCROLL_TO, { selector, x, y, behavior, offset_y, tab_id, frame_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- set_storage ---
  server.tool(
    'set_storage',
    'Write, delete, or clear localStorage, sessionStorage, or cookies',
    {
      type: z.enum(['localStorage', 'sessionStorage', 'cookie']),
      action: z.enum(['set', 'delete', 'clear']),
      key: z.string().optional().describe('Required for set/delete'),
      value: z.string().optional(),
      path: z.string().optional().describe('Cookie path (default /)'),
      domain: z.string().optional().describe('Cookie domain'),
      expires: z.string().optional().describe('UTC date string (cookie)'),
      secure: z.boolean().optional(),
      sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
      http_only: z.boolean().optional(),
      tab_id: z.number().optional(),
    },
    async ({ type, action, key, value, path, domain, expires, secure, sameSite, http_only, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.SET_STORAGE, { type, action, key, value, path, domain, expires, secure, sameSite, http_only, tab_id });
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
      wait_after: z.enum(['none', 'navigation', 'networkidle']).optional().default('none'),
      tab_id: z.number().optional(),
      frame_id: z.number().optional(),
    },
    async ({ fields, submit_selector, wait_after, tab_id, frame_id }) => {
      const before = await tabSnapshot(tab_id);
      const data = await wsManager.sendCommand(MessageType.FILL_FORM, { fields, submit_selector, tab_id, frame_id });
      const waited = await applyWaitAfter(wsManager, wait_after, tab_id);
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
    'Resize Chrome window to preset (mobile/tablet/desktop) or custom dimensions',
    {
      preset: z.enum(['mobile', 'tablet', 'desktop']).optional().describe('375x812, 768x1024, 1440x900'),
      width: z.number().optional().describe('Overrides preset'),
      height: z.number().optional().describe('Overrides preset'),
      tab_id: z.number().optional(),
    },
    async ({ preset, width, height, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.VIEWPORT_RESIZE, { preset, width, height, tab_id });
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
    'Screenshot a single element (scrolled into view, cropped). PNG.',
    {
      selector: z.string(),
      tab_id: z.number().optional(),
    },
    async ({ selector, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.ELEMENT_SCREENSHOT, { selector, tab_id });
      if (data && data.image) {
        return { content: [{ type: 'image', data: data.image, mimeType: 'image/png' }] };
      }
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- full_page_screenshot ---
  server.tool(
    'full_page_screenshot',
    'Full-page capture by scrolling: stitched segments of ~2 viewports (≤1568px, top→bottom), or one image per viewport with stitch=false.',
    {
      max_scrolls: z.number().optional().default(20),
      delay: z.number().optional().default(500).describe('ms between captures (min 500, Chrome quota)'),
      stitch: z.boolean().optional().default(true).describe('false = one image per viewport'),
      tab_id: z.number().optional(),
    },
    async ({ max_scrolls, delay, stitch, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.FULL_PAGE_SCREENSHOT, { max_scrolls, delay, stitch, tab_id });
      if (data && data.images) {
        const note = `Full page: ${data.totalCaptures} captures, ${data.images.length} segments (top→bottom), scrollHeight=${data.scrollHeight}${data.truncated ? ' (page continues beyond captured area — raise max_scrolls to capture more)' : ''}`;
        return {
          content: [
            { type: 'text', text: note },
            ...data.images.map((img) => ({ type: 'image', data: img, mimeType: 'image/png' })),
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
    'Add colored overlay on elements matching a CSS selector. remove=true clears all highlights.',
    {
      selector: z.string().optional(),
      color: z.string().optional().default('rgba(255,0,0,0.3)'),
      border: z.string().optional().default('2px solid red'),
      label: z.boolean().optional().default(false).describe('Show tag.class (WxH) label'),
      remove: z.boolean().optional().default(false),
      tab_id: z.number().optional(),
    },
    async ({ selector, color, border, label, remove, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.HIGHLIGHT_ELEMENTS, { selector, color, border, label, remove, tab_id });
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
      checks: z.array(z.enum(['images', 'links', 'headings', 'aria', 'contrast', 'forms', 'all'])).optional().default(['all']),
      tab_id: z.number().optional(),
    },
    async ({ scope, checks, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.ACCESSIBILITY_AUDIT, { scope, checks, tab_id });
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
      scope: z.enum(['same-origin', 'all', 'external']).optional().default('all'),
      selector: z.string().optional().default('a[href]'),
      timeout: z.number().optional().default(5000).describe('Per-link ms'),
      max_links: z.number().optional().default(50),
      format: z.enum(['lines', 'json']).optional().default('lines'),
      tab_id: z.number().optional(),
    },
    async ({ scope, selector, timeout, max_links, format, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.COLLECT_LINKS, { scope, selector, max_links, tab_id });
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
    'Measure pixel distance, gap, overlap, and margin/padding between two elements',
    {
      selector1: z.string(),
      selector2: z.string(),
      tab_id: z.number().optional(),
    },
    async ({ selector1, selector2, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.MEASURE_SPACING, { selector1, selector2, tab_id });
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
      selector: z.string().optional().default('body'),
      attributes: z.boolean().optional().default(true),
      childList: z.boolean().optional().default(true),
      characterData: z.boolean().optional().default(false),
      subtree: z.boolean().optional().default(true),
      clear: z.boolean().optional().default(false).describe('Clear buffer after read'),
      stop: z.boolean().optional().default(false).describe('Disconnect observer'),
      tab_id: z.number().optional(),
    },
    async ({ selector, attributes, childList, characterData, subtree, clear, stop, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.WATCH_DOM, { selector, attributes, childList, characterData, subtree, clear, stop, tab_id });
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
    'Emulate prefers-color-scheme, prefers-reduced-motion, print mode (matchMedia override + CSS).',
    {
      colorScheme: z.enum(['dark', 'light', 'no-preference']).optional(),
      reducedMotion: z.enum(['reduce', 'no-preference']).optional(),
      printMode: z.boolean().optional().default(false),
      reset: z.boolean().optional().default(false).describe('Remove all emulations'),
      tab_id: z.number().optional(),
    },
    async ({ colorScheme, reducedMotion, printMode, reset, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.EMULATE_MEDIA, { colorScheme, reducedMotion, printMode, reset, tab_id });
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
      selector: z.string().optional(),
      ref: z.string().optional().describe('From get_interactives'),
      tab_id: z.number().optional(),
      frame_id: z.number().optional(),
    },
    async ({ selector, ref, tab_id, frame_id }) => {
      const data = await wsManager.sendCommand(MessageType.HOVER, { selector: resolveTarget(selector, ref, tab_id), tab_id, frame_id });
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
    'Press a keyboard key with optional modifiers (keydown/keypress/keyup).',
    {
      key: z.string().describe('e.g. "Enter", "Escape", "Tab", "ArrowDown"'),
      selector: z.string().optional().describe('Target (default: activeElement)'),
      ctrl: z.boolean().optional().default(false),
      shift: z.boolean().optional().default(false),
      alt: z.boolean().optional().default(false),
      meta: z.boolean().optional().default(false),
      tab_id: z.number().optional(),
      frame_id: z.number().optional(),
    },
    async ({ key, selector, ctrl, shift, alt, meta, tab_id, frame_id }) => {
      const data = await wsManager.sendCommand(MessageType.PRESS_KEY, { key, selector, ctrl, shift, alt, meta, tab_id, frame_id });
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
      tab_id: z.number().optional(),
    },
    async ({ tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.GET_FRAMES, { tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- tab_action ---
  server.tool(
    'tab_action',
    'Tab lifecycle actions: close, activate (focus), reload (optional cache bypass), back, forward',
    {
      action: z.enum(['close', 'activate', 'reload', 'back', 'forward']),
      bypass_cache: z.boolean().optional().default(false).describe('reload only'),
      tab_id: z.number().optional(),
    },
    async ({ action, bypass_cache, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.TAB_ACTION, { action, bypass_cache, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- upload_file ---
  server.tool(
    'upload_file',
    'Set a file on input[type=file] from the server filesystem via DataTransfer (max 10MB).',
    {
      selector: z.string(),
      path: z.string().describe('Absolute path on the server machine'),
      mime_type: z.string().optional().describe('Default: inferred from extension'),
      tab_id: z.number().optional(),
    },
    async ({ selector, path, mime_type, tab_id }) => {
      const buf = await readFile(path);
      if (buf.length > 10 * 1024 * 1024) throw new Error(`File too large: ${buf.length} bytes (max 10MB)`);
      const mime = mime_type || MIME_BY_EXT[extname(path).toLowerCase()] || 'application/octet-stream';
      const data = await wsManager.sendCommand(MessageType.UPLOAD_FILE, {
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
      tab_id: z.number().optional(),
    },
    async ({ tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.DISMISS_OVERLAYS, { tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- handle_dialogs ---
  server.tool(
    'handle_dialogs',
    'Auto-accept/dismiss future JS dialogs (alert/confirm/prompt), logging them. reset restores native dialogs and returns the log.',
    {
      action: z.enum(['accept', 'dismiss', 'reset']).optional().default('accept'),
      prompt_text: z.string().optional().describe('Returned by window.prompt on accept'),
      tab_id: z.number().optional(),
    },
    async ({ action, prompt_text, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.HANDLE_DIALOGS, { action, prompt_text, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- find_text ---
  server.tool(
    'find_text',
    'Find text on the page: parent selector, context, visibility, position per match. Attaches nearby interactive elements (with refs for click/type_text/hover) for the first visible match.',
    {
      text: z.string(),
      case_sensitive: z.boolean().optional().default(false),
      max_results: z.number().optional().default(20),
      tab_id: z.number().optional(),
    },
    async ({ text, case_sensitive, max_results, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.FIND_TEXT, { text, case_sensitive, max_results, tab_id });
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
          const inter = await wsManager.sendCommand(MessageType.GET_INTERACTIVES, { limit: 3000, visible_only: true, tab_id });
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
    'Network interception, browser-wide, survives reloads until cleared: block requests, redirect URLs (mock endpoints), set/remove request headers.',
    {
      action: z.enum(['block', 'redirect', 'modify_header', 'list', 'clear']),
      url_filter: z.string().optional().describe('declarativeNetRequest urlFilter, e.g. "||example.com/api/*"'),
      redirect_url: z.string().optional(),
      header: z.string().optional(),
      header_value: z.string().optional().describe('Omit to remove header'),
      resource_types: z.array(z.enum(['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'])).optional(),
    },
    async ({ action, url_filter, redirect_url, header, header_value, resource_types }) => {
      const data = await wsManager.sendCommand(MessageType.NETWORK_RULES, { action, url_filter, redirect_url, header, header_value, resource_types });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- screenshot_diff ---
  server.tool(
    'screenshot_diff',
    'Visual regression: save a named baseline (viewport or element), compare later — returns changed-pixel % and red-highlighted diff image. Baselines are in-memory (lost on service worker restart).',
    {
      action: z.enum(['baseline', 'compare', 'list', 'clear']),
      name: z.string().optional().default('default'),
      selector: z.string().optional().describe('Capture one element (default viewport)'),
      threshold: z.number().optional().default(10).describe('Per-channel tolerance 0-255'),
      tab_id: z.number().optional(),
    },
    async ({ action, name, selector, threshold, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.SCREENSHOT_DIFF, { action, name, selector, threshold, tab_id });
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
    'Core Web Vitals since page load: CLS, LCP, FCP, TTFB, long tasks, INP approximation.',
    {
      tab_id: z.number().optional(),
    },
    async ({ tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.WEB_VITALS, { tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- list_event_listeners ---
  server.tool(
    'list_event_listeners',
    'List addEventListener registrations since page load: counts by type + recent entries.',
    {
      type: z.string().optional().describe('e.g. "click"'),
      limit: z.number().optional().default(100),
      tab_id: z.number().optional(),
    },
    async ({ type, limit, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.LIST_EVENT_LISTENERS, { type, limit, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- monitor_websocket ---
  server.tool(
    'monitor_websocket',
    'Monitor WebSocket connections/messages (500-char previews). Hook installs on first call; earlier connections are missed.',
    {
      clear: z.boolean().optional().default(false).describe('Clear buffer after read'),
      tab_id: z.number().optional(),
    },
    async ({ clear, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.MONITOR_WEBSOCKET, { clear, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- seo_audit ---
  server.tool(
    'seo_audit',
    'SEO audit: title/description lengths, canonical, robots, h1 count, Open Graph, Twitter card, JSON-LD validity, hreflang, lang, viewport, favicon',
    {
      tab_id: z.number().optional(),
    },
    async ({ tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.SEO_AUDIT, { tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- extract_table ---
  server.tool(
    'extract_table',
    'Extract an HTML table as JSON (thead headers, rows as objects). index picks among multiple matches.',
    {
      selector: z.string().optional().default('table'),
      index: z.number().optional().default(0),
      max_rows: z.number().optional().default(100),
      tab_id: z.number().optional(),
    },
    async ({ selector, index, max_rows, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.EXTRACT_TABLE, { selector, index, max_rows, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- unused_css ---
  server.tool(
    'unused_css',
    'List CSS selectors matching nothing in the current DOM (approximate; cross-origin sheets unreadable).',
    {
      max_selectors: z.number().optional().default(200),
      tab_id: z.number().optional(),
    },
    async ({ max_selectors, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.UNUSED_CSS, { max_selectors, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- drag_and_drop ---
  server.tool(
    'drag_and_drop',
    'Drag an element onto another. html5 = DragEvent+DataTransfer; pointer = pointer/mouse events (sortable libraries).',
    {
      source_selector: z.string(),
      target_selector: z.string(),
      mode: z.enum(['html5', 'pointer']).optional().default('html5'),
      frame_id: z.number().optional(),
      tab_id: z.number().optional(),
    },
    async ({ source_selector, target_selector, mode, frame_id, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.DRAG_AND_DROP, { source_selector, target_selector, mode, frame_id, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- clipboard ---
  server.tool(
    'clipboard',
    'Read or write the system clipboard (text). Activates the tab first.',
    {
      action: z.enum(['read', 'write']),
      text: z.string().optional().describe('For write'),
      tab_id: z.number().optional(),
    },
    async ({ action, text, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.CLIPBOARD, { action, text, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- set_geolocation ---
  server.tool(
    'set_geolocation',
    'Override navigator.geolocation with fixed coordinates (page-level patch). reset restores native.',
    {
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      accuracy: z.number().optional().default(10).describe('Meters'),
      reset: z.boolean().optional().default(false),
      tab_id: z.number().optional(),
    },
    async ({ latitude, longitude, accuracy, reset, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.SET_GEOLOCATION, { latitude, longitude, accuracy, reset, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- manage_downloads ---
  server.tool(
    'manage_downloads',
    'List downloads or wait for one to complete. Files land in the browser Downloads folder, not on the server.',
    {
      action: z.enum(['list', 'wait_for_complete']),
      timeout: z.number().optional().default(30000).describe('Max ms (wait_for_complete)'),
      limit: z.number().optional().default(10),
    },
    async ({ action, timeout, limit }) => {
      const data = await wsManager.sendCommand(MessageType.MANAGE_DOWNLOADS, { action, timeout, limit });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- save_page ---
  server.tool(
    'save_page',
    'Save the full page (DOM, styles, images) as an MHTML archive file on the server filesystem.',
    {
      output_path: z.string().describe('Absolute file path to write (e.g. /tmp/page.mhtml)'),
      tab_id: z.number().optional(),
    },
    async ({ output_path, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.SAVE_PAGE, { tab_id });
      await writeFile(output_path, Buffer.from(data.mhtml_b64, 'base64'));
      return { content: [{ type: 'text', text: jsonText({ saved: output_path, size: data.size }) }] };
    }
  );

  // --- set_zoom ---
  server.tool(
    'set_zoom',
    'Get or set tab zoom (0.25–5). No factor = read current; reset restores default.',
    {
      factor: z.number().optional().describe('1 = 100%'),
      reset: z.boolean().optional().default(false),
      tab_id: z.number().optional(),
    },
    async ({ factor, reset, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.SET_ZOOM, { factor, reset, tab_id });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- http_auth ---
  server.tool(
    'http_auth',
    'Set/clear credentials for HTTP Basic/Digest auth dialogs (browser-wide, in-memory only).',
    {
      action: z.enum(['set', 'clear']),
      username: z.string().optional(),
      password: z.string().optional(),
    },
    async ({ action, username, password }) => {
      if (action === 'set' && !username) throw new Error('username is required for action=set');
      const data = await wsManager.sendCommand(MessageType.HTTP_AUTH, { action, username, password });
      return { content: [{ type: 'text', text: jsonText(data) }] };
    }
  );

  // --- security_headers ---
  server.tool(
    'security_headers',
    'Audit security headers (CSP, HSTS, XCTO, clickjacking, Referrer/Permissions-Policy, version leaks). Captured from real navigations — reload if unavailable.',
    {
      tab_id: z.number().optional(),
    },
    async ({ tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.GET_RESPONSE_HEADERS, { tab_id });
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
    'Save/restore localStorage+sessionStorage+cookies as a named fixture (e.g. a logged-in state). Restore requires the tab to be on the origin recorded at save.',
    {
      action: z.enum(['save', 'restore', 'list']),
      name: z.string().optional().describe('Required for save/restore'),
      tab_id: z.number().optional(),
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
        const tabs = await wsManager.sendCommand(MessageType.GET_TABS);
        const list = Array.isArray(tabs) ? tabs : [];
        const tab = tab_id != null ? list.find((t) => t.id === tab_id) : list.find((t) => t.active);
        try { return tab?.url ? new URL(tab.url).origin : null; } catch { return null; }
      };

      if (action === 'save') {
        const data = await wsManager.sendCommand(MessageType.GET_STORAGE, { type: 'all', tab_id });
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
          await wsManager.sendCommand(MessageType.SET_STORAGE, { type: storageType, action: 'set', key: k, value: v, tab_id });
          restored[storageType]++;
        }
      }
      for (const c of fixture.cookies || []) {
        try {
          await wsManager.sendCommand(MessageType.SET_STORAGE, {
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
      limit: z.number().optional().default(100),
      visible_only: z.boolean().optional().default(true),
      format: z.enum(['lines', 'json']).optional().default('lines'),
      frame_id: z.number().optional(),
      tab_id: z.number().optional(),
    },
    async ({ scope, limit, visible_only, format, frame_id, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.GET_INTERACTIVES, { scope, limit, visible_only, frame_id, tab_id });
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
}
