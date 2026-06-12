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

const SESSIONS_DIR = join(homedir(), '.config', 'chrome-bridge', 'sessions');

function truncateText(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated, ${text.length - max} more chars — use max_length to raise the limit]`;
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
 * Registra tutti i tool MCP.
 *
 * @param {import('@modelcontextprotocol/sdk/server/index.js').McpServer} server - MCP Server
 * @param {import('./ws-manager.js').WSManager} wsManager - WebSocket manager
 */
export function registerTools(server, wsManager) {
  const startedAt = Date.now();

  // --- get_status ---
  server.tool(
    'get_status',
    'Check bridge status: extension connection, server mode (primary/relay), port, version',
    {},
    async () => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            connected: wsManager.isConnected(),
            mode: wsManager.mode,
            port: wsManager.port,
            version: VERSION,
            uptime_sec: Math.round((Date.now() - startedAt) / 1000),
          }, null, 2),
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
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- navigate ---
  server.tool(
    'navigate',
    'Navigate a Chrome tab to a URL',
    {
      url:    z.string().describe('The URL to navigate to'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ url, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.NAVIGATE, { url, tab_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- screenshot ---
  server.tool(
    'screenshot',
    'Take a screenshot of a Chrome tab (returns base64 PNG image). Note: brings the tab to foreground and focuses its window.',
    {
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
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
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- execute_js ---
  server.tool(
    'execute_js',
    'Execute JavaScript code in a Chrome tab page context',
    {
      code:       z.string().describe('JavaScript code to execute'),
      tab_id:     z.number().optional().describe('Tab ID (default: active tab)'),
      frame_id:   z.number().optional().describe('Frame ID to target (from get_frames; default: main frame)'),
      max_length: z.number().optional().default(20000).describe('Max output chars (default 20000)'),
    },
    async ({ code, tab_id, frame_id, max_length }) => {
      const data = await wsManager.sendCommand(MessageType.EXECUTE_JS, { code, tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: truncateText(JSON.stringify(data, null, 2), max_length),
        }],
      };
    }
  );

  // --- click ---
  server.tool(
    'click',
    'Click on an element identified by CSS selector. Supports shadow DOM piercing with ">>>" (e.g. "my-app >>> button.save").',
    {
      selector: z.string().describe('CSS selector of the element to click'),
      force:    z.boolean().optional().default(false).describe('Skip the occlusion check and click even if covered by another element'),
      wait_after: z.enum(['none', 'navigation', 'networkidle']).optional().default('none').describe('After clicking, wait for navigation to complete or the network to go idle'),
      tab_id:   z.number().optional().describe('Tab ID (default: active tab)'),
      frame_id: z.number().optional().describe('Frame ID to target (from get_frames; default: main frame)'),
    },
    async ({ selector, force, wait_after, tab_id, frame_id }) => {
      const data = await wsManager.sendCommand(MessageType.CLICK, { selector, force, frame_id, tab_id });
      // Niente attesa se il click non è andato a buon fine (es. elemento occluso)
      const waited = data?.occluded ? null : await applyWaitAfter(wsManager, wait_after, tab_id);
      const out = waited ? { ...data, wait_after: waited } : data;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(out, null, 2),
        }],
      };
    }
  );

  // --- type_text ---
  server.tool(
    'type_text',
    'Type text into an input element identified by CSS selector. Supports shadow DOM piercing with ">>>" (e.g. "my-app >>> button.save").',
    {
      selector: z.string().describe('CSS selector of the input element'),
      text:     z.string().describe('Text to type'),
      mode:     z.enum(['set', 'keys']).optional().default('set').describe('set = assign value directly (fast); keys = per-character key events (for autocomplete/masked inputs)'),
      wait_after: z.enum(['none', 'navigation', 'networkidle']).optional().default('none').describe('After typing, wait for navigation to complete or the network to go idle'),
      tab_id:   z.number().optional().describe('Tab ID (default: active tab)'),
      frame_id: z.number().optional().describe('Frame ID to target (from get_frames; default: main frame)'),
    },
    async ({ selector, text, mode, wait_after, tab_id, frame_id }) => {
      const data = await wsManager.sendCommand(MessageType.TYPE_TEXT, { selector, text, mode, tab_id, frame_id });
      const waited = await applyWaitAfter(wsManager, wait_after, tab_id);
      const out = waited ? { ...data, wait_after: waited } : data;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(out, null, 2),
        }],
      };
    }
  );

  // --- read_page ---
  server.tool(
    'read_page',
    'Read the content of a Chrome tab page',
    {
      mode:       z.enum(['text', 'html', 'accessibility']).default('text').describe('Content mode: text (visible text), html (full HTML), accessibility (a11y tree)'),
      tab_id:     z.number().optional().describe('Tab ID (default: active tab)'),
      frame_id:   z.number().optional().describe('Frame ID to target (from get_frames; default: main frame)'),
      max_length: z.number().optional().default(50000).describe('Max output chars (default 50000)'),
    },
    async ({ mode, tab_id, frame_id, max_length }) => {
      const data = await wsManager.sendCommand(MessageType.READ_PAGE, { mode, tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: truncateText(typeof data === 'string' ? data : JSON.stringify(data, null, 2), max_length),
        }],
      };
    }
  );

  // --- get_page_info ---
  server.tool(
    'get_page_info',
    'Get page metadata: meta tags, scripts, stylesheets, links, and forms',
    {
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
      frame_id: z.number().optional().describe('Frame ID to target (from get_frames; default: main frame)'),
    },
    async ({ tab_id, frame_id }) => {
      const data = await wsManager.sendCommand(MessageType.GET_PAGE_INFO, { tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- get_storage ---
  server.tool(
    'get_storage',
    'Get page storage: localStorage, sessionStorage, and cookies',
    {
      type:   z.enum(['all', 'localStorage', 'sessionStorage', 'cookies']).default('all').describe('Which storage to read'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ type, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.GET_STORAGE, { type, tab_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- get_performance ---
  server.tool(
    'get_performance',
    'Get page performance metrics: navigation timing, paint metrics, memory, and resource loading',
    {
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.GET_PERFORMANCE, { tab_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- query_dom ---
  server.tool(
    'query_dom',
    'Query DOM elements by CSS selector, returning structure, attributes, bounding rect, and computed styles. Supports shadow DOM piercing with ">>>" (e.g. "my-app >>> button.save").',
    {
      selector: z.string().describe('CSS selector to query'),
      properties: z.array(z.string()).optional().describe('Computed style properties to include (e.g. ["color", "font-size"])'),
      limit: z.number().optional().default(50).describe('Max elements to return (default 50)'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
      frame_id: z.number().optional().describe('Frame ID to target (from get_frames; default: main frame)'),
    },
    async ({ selector, properties, limit, tab_id, frame_id }) => {
      const data = await wsManager.sendCommand(MessageType.QUERY_DOM, { selector, properties, limit, tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- modify_dom ---
  server.tool(
    'modify_dom',
    'Modify DOM elements: setAttribute, removeAttribute, addClass, removeClass, setStyle, setTextContent',
    {
      selector: z.string().describe('CSS selector of the target element'),
      action: z.enum(['setAttribute', 'removeAttribute', 'addClass', 'removeClass', 'setStyle', 'setTextContent']).describe('Action to perform'),
      name: z.string().optional().describe('Attribute name (for setAttribute/removeAttribute)'),
      value: z.string().optional().describe('Value to set (for setAttribute, setStyle, setTextContent)'),
      className: z.string().optional().describe('Class name (for addClass/removeClass)'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
      frame_id: z.number().optional().describe('Frame ID to target (from get_frames; default: main frame)'),
    },
    async ({ selector, action, name, value, className, tab_id, frame_id }) => {
      const data = await wsManager.sendCommand(MessageType.MODIFY_DOM, { selector, action, name, value, className, tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- inject_css ---
  server.tool(
    'inject_css',
    'Inject CSS rules into a Chrome tab page',
    {
      css: z.string().describe('CSS rules to inject'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ css, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.INJECT_CSS, { css, tab_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- read_console ---
  server.tool(
    'read_console',
    'Read console messages captured from page load (hook installed at document_start), including uncaught errors and unhandled rejections.',
    {
      clear: z.boolean().optional().default(false).describe('Clear captured messages after reading'),
      level: z.enum(['all', 'log', 'warn', 'error', 'info', 'debug']).optional().default('all').describe('Filter by log level'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ clear, level, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.READ_CONSOLE, { clear, level, tab_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- monitor_network ---
  server.tool(
    'monitor_network',
    'Monitor network requests. source=page captures XHR/fetch via in-page hook (first call installs it); source=browser captures all requests incl. static assets via webRequest. format=har exports HAR 1.2.',
    {
      clear: z.boolean().optional().default(false).describe('Clear captured requests after reading'),
      source: z.enum(['page', 'browser']).optional().default('page').describe('page = fetch/XHR hook; browser = all requests incl. static assets via webRequest'),
      format: z.enum(['json', 'har']).optional().default('json').describe('Output format'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ clear, source, format, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.MONITOR_NETWORK, { clear, source, tab_id });
      const out = format === 'har' ? toHar(data.requests ?? []) : data;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(out, null, 2),
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
      active: z.boolean().optional().default(true).describe('Whether the tab should be active'),
    },
    async ({ url, active }) => {
      const data = await wsManager.sendCommand(MessageType.CREATE_TAB, { url, active });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- wait_for_element ---
  server.tool(
    'wait_for_element',
    'Wait for a CSS selector to appear in the DOM, with optional visibility check. Polls until found or timeout. Supports shadow DOM piercing with ">>>" (e.g. "my-app >>> button.save").',
    {
      selector: z.string().describe('CSS selector to wait for'),
      timeout: z.number().optional().default(10000).describe('Max wait time in ms (default 10000)'),
      interval: z.number().optional().default(200).describe('Poll interval in ms (default 200, min 50)'),
      visible: z.boolean().optional().default(false).describe('Also require the element to be visible'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
      frame_id: z.number().optional().describe('Frame ID to target (from get_frames; default: main frame)'),
    },
    async ({ selector, timeout, interval, visible, tab_id, frame_id }) => {
      const data = await wsManager.sendCommand(MessageType.WAIT_FOR_ELEMENT, { selector, timeout, interval, visible, tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- scroll_to ---
  server.tool(
    'scroll_to',
    'Scroll to an element or coordinates. Supports smooth/instant behavior and offset for fixed headers.',
    {
      selector: z.string().optional().describe('CSS selector to scroll to'),
      x: z.number().optional().describe('X coordinate to scroll to'),
      y: z.number().optional().describe('Y coordinate to scroll to'),
      behavior: z.enum(['smooth', 'instant', 'auto']).optional().default('auto').describe('Scroll behavior'),
      offset_y: z.number().optional().default(0).describe('Vertical offset in px (e.g. for fixed headers)'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
      frame_id: z.number().optional().describe('Frame ID to target (from get_frames; default: main frame)'),
    },
    async ({ selector, x, y, behavior, offset_y, tab_id, frame_id }) => {
      const data = await wsManager.sendCommand(MessageType.SCROLL_TO, { selector, x, y, behavior, offset_y, tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- set_storage ---
  server.tool(
    'set_storage',
    'Write, delete, or clear localStorage, sessionStorage, or cookies',
    {
      type: z.enum(['localStorage', 'sessionStorage', 'cookie']).describe('Storage type to modify'),
      action: z.enum(['set', 'delete', 'clear']).describe('Action to perform'),
      key: z.string().optional().describe('Storage key (required for set/delete, ignored for clear)'),
      value: z.string().optional().describe('Value to set (for set action)'),
      path: z.string().optional().describe('Cookie path (default /)'),
      domain: z.string().optional().describe('Cookie domain'),
      expires: z.string().optional().describe('Cookie expires (UTC date string)'),
      secure: z.boolean().optional().describe('Cookie Secure flag'),
      sameSite: z.enum(['Strict', 'Lax', 'None']).optional().describe('Cookie SameSite attribute'),
      http_only: z.boolean().optional().describe('Cookie HttpOnly flag'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ type, action, key, value, path, domain, expires, secure, sameSite, http_only, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.SET_STORAGE, { type, action, key, value, path, domain, expires, secure, sameSite, http_only, tab_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
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
        selector: z.string().describe('CSS selector of the form field'),
        value: z.string().describe('Value to set'),
      })).describe('Array of {selector, value} pairs to fill'),
      submit_selector: z.string().optional().describe('CSS selector of submit button to click after filling'),
      wait_after: z.enum(['none', 'navigation', 'networkidle']).optional().default('none').describe('After filling/submitting, wait for navigation to complete or the network to go idle'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
      frame_id: z.number().optional().describe('Frame ID to target (from get_frames; default: main frame)'),
    },
    async ({ fields, submit_selector, wait_after, tab_id, frame_id }) => {
      const data = await wsManager.sendCommand(MessageType.FILL_FORM, { fields, submit_selector, tab_id, frame_id });
      const waited = await applyWaitAfter(wsManager, wait_after, tab_id);
      const out = waited ? { ...data, wait_after: waited } : data;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(out, null, 2),
        }],
      };
    }
  );

  // --- viewport_resize ---
  server.tool(
    'viewport_resize',
    'Resize Chrome window to preset (mobile/tablet/desktop) or custom dimensions',
    {
      preset: z.enum(['mobile', 'tablet', 'desktop']).optional().describe('Device preset: mobile=375x812, tablet=768x1024, desktop=1440x900'),
      width: z.number().optional().describe('Custom width (overrides preset)'),
      height: z.number().optional().describe('Custom height (overrides preset)'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ preset, width, height, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.VIEWPORT_RESIZE, { preset, width, height, tab_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- element_screenshot ---
  server.tool(
    'element_screenshot',
    'Screenshot of a single element (scrolled into view, cropped via OffscreenCanvas). Returns base64 PNG. Brings tab to foreground.',
    {
      selector: z.string().describe('CSS selector of the element'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ selector, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.ELEMENT_SCREENSHOT, { selector, tab_id });
      if (data && data.image) {
        return { content: [{ type: 'image', data: data.image, mimeType: 'image/png' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- full_page_screenshot ---
  server.tool(
    'full_page_screenshot',
    'Capture full page by scrolling and taking viewport screenshots, stitched into a single PNG via OffscreenCanvas (or one image per viewport with stitch=false). Note: brings the tab to foreground and focuses its window.',
    {
      max_scrolls: z.number().optional().default(20).describe('Max scroll steps (default 20)'),
      delay: z.number().optional().default(500).describe('Delay between captures in ms (min 500, Chrome quota is 2 captures/sec)'),
      stitch: z.boolean().optional().default(true).describe('Stitch captures into one PNG (default true). false returns one image per viewport.'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ max_scrolls, delay, stitch, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.FULL_PAGE_SCREENSHOT, { max_scrolls, delay, stitch, tab_id });
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
    'Add colored overlay on elements matching a CSS selector. Use remove=true to clear all highlights.',
    {
      selector: z.string().optional().describe('CSS selector of elements to highlight'),
      color: z.string().optional().default('rgba(255,0,0,0.3)').describe('Overlay background color'),
      border: z.string().optional().default('2px solid red').describe('Overlay border style'),
      label: z.boolean().optional().default(false).describe('Show tag.class (WxH) label on each element'),
      remove: z.boolean().optional().default(false).describe('Remove all existing highlights instead'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ selector, color, border, label, remove, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.HIGHLIGHT_ELEMENTS, { selector, color, border, label, remove, tab_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- accessibility_audit ---
  server.tool(
    'accessibility_audit',
    'Run accessibility audit: missing alt, empty links, heading hierarchy, ARIA issues, contrast, form labels. Contrast check is approximate (ignores background images/gradients and alpha compositing).',
    {
      scope: z.string().optional().describe('CSS selector to limit audit scope (default: whole page)'),
      checks: z.array(z.enum(['images', 'links', 'headings', 'aria', 'contrast', 'forms', 'all'])).optional().default(['all']).describe('Which checks to run'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ scope, checks, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.ACCESSIBILITY_AUDIT, { scope, checks, tab_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- check_links ---
  server.tool(
    'check_links',
    'Check links on the page for broken URLs. Links are collected in the page, then verified server-side (no CORS limits, real HTTP status for external links too).',
    {
      scope: z.enum(['same-origin', 'all', 'external']).optional().default('all').describe('Link scope'),
      selector: z.string().optional().default('a[href]').describe('CSS selector to find links'),
      timeout: z.number().optional().default(5000).describe('Per-link fetch timeout in ms'),
      max_links: z.number().optional().default(50).describe('Max links to check'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ scope, selector, timeout, max_links, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.COLLECT_LINKS, { scope, selector, max_links, tab_id });
      const links = data.links ?? [];
      const results = await checkLinksBatch(links, timeout);
      const broken = results.filter((r) => r.broken).length;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ total: links.length, checked: results.length, broken, totalAnchors: data.totalAnchors, results }, null, 2),
        }],
      };
    }
  );

  // --- measure_spacing ---
  server.tool(
    'measure_spacing',
    'Measure pixel distance, gap, overlap, and margin/padding between two elements',
    {
      selector1: z.string().describe('CSS selector of first element'),
      selector2: z.string().describe('CSS selector of second element'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ selector1, selector2, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.MEASURE_SPACING, { selector1, selector2, tab_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- watch_dom ---
  server.tool(
    'watch_dom',
    'Watch DOM mutations via MutationObserver. First call installs the watcher; subsequent calls read accumulated mutations.',
    {
      selector: z.string().optional().default('body').describe('CSS selector of element to observe (default: body)'),
      attributes: z.boolean().optional().default(true).describe('Watch attribute changes'),
      childList: z.boolean().optional().default(true).describe('Watch child additions/removals'),
      characterData: z.boolean().optional().default(false).describe('Watch text content changes'),
      subtree: z.boolean().optional().default(true).describe('Watch all descendants'),
      clear: z.boolean().optional().default(false).describe('Clear accumulated mutations after reading'),
      stop: z.boolean().optional().default(false).describe('Disconnect observer and cleanup'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ selector, attributes, childList, characterData, subtree, clear, stop, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.WATCH_DOM, { selector, attributes, childList, characterData, subtree, clear, stop, tab_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- emulate_media ---
  server.tool(
    'emulate_media',
    'Emulate media features: dark/light mode, reduced-motion, print mode. Overrides matchMedia and injects CSS.',
    {
      colorScheme: z.enum(['dark', 'light', 'no-preference']).optional().describe('Emulate prefers-color-scheme'),
      reducedMotion: z.enum(['reduce', 'no-preference']).optional().describe('Emulate prefers-reduced-motion'),
      printMode: z.boolean().optional().default(false).describe('Emulate print media type'),
      reset: z.boolean().optional().default(false).describe('Remove all media emulations'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ colorScheme, reducedMotion, printMode, reset, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.EMULATE_MEDIA, { colorScheme, reducedMotion, printMode, reset, tab_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- hover ---
  server.tool(
    'hover',
    'Hover over an element identified by CSS selector. Dispatches mouseenter and mouseover events. Supports shadow DOM piercing with ">>>" (e.g. "my-app >>> button.save").',
    {
      selector: z.string().describe('CSS selector of the element to hover'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
      frame_id: z.number().optional().describe('Frame ID to target (from get_frames; default: main frame)'),
    },
    async ({ selector, tab_id, frame_id }) => {
      const data = await wsManager.sendCommand(MessageType.HOVER, { selector, tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- press_key ---
  server.tool(
    'press_key',
    'Press a keyboard key with optional modifiers. Dispatches keydown, keypress (for printable), and keyup events. Supports shadow DOM piercing with ">>>" (e.g. "my-app >>> button.save").',
    {
      key: z.string().describe('Key to press (e.g. "Enter", "Escape", "Tab", "a", "ArrowDown")'),
      selector: z.string().optional().describe('CSS selector of element to target (default: document.activeElement)'),
      ctrl: z.boolean().optional().default(false).describe('Hold Ctrl'),
      shift: z.boolean().optional().default(false).describe('Hold Shift'),
      alt: z.boolean().optional().default(false).describe('Hold Alt'),
      meta: z.boolean().optional().default(false).describe('Hold Meta/Cmd'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
      frame_id: z.number().optional().describe('Frame ID to target (from get_frames; default: main frame)'),
    },
    async ({ key, selector, ctrl, shift, alt, meta, tab_id, frame_id }) => {
      const data = await wsManager.sendCommand(MessageType.PRESS_KEY, { key, selector, ctrl, shift, alt, meta, tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- get_frames ---
  server.tool(
    'get_frames',
    'List all frames (main + iframes) in a tab with their frameId, parent and URL. Use frameId with the frame_id parameter of DOM tools.',
    {
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.GET_FRAMES, { tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- tab_action ---
  server.tool(
    'tab_action',
    'Tab lifecycle actions: close, activate (focus), reload (optional cache bypass), back, forward',
    {
      action: z.enum(['close', 'activate', 'reload', 'back', 'forward']).describe('Action to perform'),
      bypass_cache: z.boolean().optional().default(false).describe('For reload: bypass HTTP cache'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ action, bypass_cache, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.TAB_ACTION, { action, bypass_cache, tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- upload_file ---
  server.tool(
    'upload_file',
    'Set a file on an input[type=file] element. Reads the file from the server filesystem and injects it via DataTransfer (max 10MB).',
    {
      selector: z.string().describe('CSS selector of the file input'),
      path: z.string().describe('Absolute path of the file on the server machine'),
      mime_type: z.string().optional().describe('MIME type (default: inferred from extension)'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ selector, path, mime_type, tab_id }) => {
      const buf = await readFile(path);
      if (buf.length > 10 * 1024 * 1024) throw new Error(`File too large: ${buf.length} bytes (max 10MB)`);
      const mime = mime_type || MIME_BY_EXT[extname(path).toLowerCase()] || 'application/octet-stream';
      const data = await wsManager.sendCommand(MessageType.UPLOAD_FILE, {
        selector, name: basename(path), mime_type: mime, content_b64: buf.toString('base64'), tab_id,
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- wait_for_navigation ---
  server.tool(
    'wait_for_navigation',
    'Wait for the tab to finish navigating (e.g. after a click that triggers a page load). Resolves when tab status is complete.',
    {
      timeout: z.number().optional().default(15000).describe('Max wait in ms'),
      mode: z.enum(['load', 'spa']).optional().default('load').describe('load = full page navigation (status complete); spa = single-page route change (history.pushState/popstate/hashchange)'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ timeout, mode, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.WAIT_FOR_NAVIGATION, { timeout, mode, tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- dismiss_overlays ---
  server.tool(
    'dismiss_overlays',
    'Dismiss cookie-consent banners and modal overlays by clicking the accept/agree button. Tries known consent frameworks (OneTrust, Cookiebot, Usercentrics) then a generic heuristic (accept-text button inside a fixed/high-z-index overlay). Idempotent.',
    {
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.DISMISS_OVERLAYS, { tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- wait_for_network_idle ---
  server.tool(
    'wait_for_network_idle',
    'Wait until no XHR/fetch requests are in flight for idle_ms. Useful after actions that trigger async loading.',
    {
      idle_ms: z.number().optional().default(500).describe('Quiet period in ms'),
      timeout: z.number().optional().default(15000).describe('Max wait in ms'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ idle_ms, timeout, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.WAIT_FOR_NETWORK_IDLE, { idle_ms, timeout, tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- handle_dialogs ---
  server.tool(
    'handle_dialogs',
    'Auto-handle JS dialogs (alert/confirm/prompt): accept or dismiss future dialogs, log intercepted ones. action=reset restores native dialogs and returns the log. Does not cover beforeunload or browser-native dialogs.',
    {
      action: z.enum(['accept', 'dismiss', 'reset']).optional().default('accept').describe('Policy for future dialogs, or reset'),
      prompt_text: z.string().optional().describe('Text returned by window.prompt when accepting'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ action, prompt_text, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.HANDLE_DIALOGS, { action, prompt_text, tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- find_text ---
  server.tool(
    'find_text',
    'Find text occurrences on the page. Returns parent element selector, surrounding context, visibility and page position for each match.',
    {
      text: z.string().describe('Text to search for'),
      case_sensitive: z.boolean().optional().default(false).describe('Case-sensitive match'),
      max_results: z.number().optional().default(20).describe('Max matches to return'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ text, case_sensitive, max_results, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.FIND_TEXT, { text, case_sensitive, max_results, tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- network_rules ---
  server.tool(
    'network_rules',
    'Manage network interception rules (browser-wide, not per-tab): block requests, redirect URLs (e.g. mock an API endpoint), set/remove request headers. Uses declarativeNetRequest — survives page reloads until cleared.',
    {
      action: z.enum(['block', 'redirect', 'modify_header', 'list', 'clear']).describe('Rule action'),
      url_filter: z.string().optional().describe('URL filter pattern (declarativeNetRequest urlFilter syntax, e.g. "||example.com/api/*")'),
      redirect_url: z.string().optional().describe('Target URL for redirect action'),
      header: z.string().optional().describe('Header name for modify_header'),
      header_value: z.string().optional().describe('Header value (omit to remove the header)'),
      resource_types: z.array(z.enum(['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'])).optional().describe('Limit rule to these resource types'),
    },
    async ({ action, url_filter, redirect_url, header, header_value, resource_types }) => {
      const data = await wsManager.sendCommand(MessageType.NETWORK_RULES, { action, url_filter, redirect_url, header, header_value, resource_types });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- screenshot_diff ---
  server.tool(
    'screenshot_diff',
    'Visual regression: capture a named baseline screenshot (viewport or element), then compare later — returns changed-pixel percentage and a diff image (changes in red over faded baseline). Baselines live in extension memory and are lost if the service worker restarts. Brings tab to foreground.',
    {
      action: z.enum(['baseline', 'compare', 'list', 'clear']).describe('baseline = capture reference; compare = diff against it'),
      name: z.string().optional().default('default').describe('Baseline name'),
      selector: z.string().optional().describe('CSS selector to capture just one element (default: viewport; compare reuses baseline selector)'),
      threshold: z.number().optional().default(10).describe('Per-channel tolerance 0-255 before a pixel counts as changed'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ action, name, selector, threshold, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.SCREENSHOT_DIFF, { action, name, selector, threshold, tab_id });
      if (data && data.diff_image) {
        const { diff_image, ...rest } = data;
        return {
          content: [
            { type: 'text', text: JSON.stringify(rest, null, 2) },
            { type: 'image', data: diff_image, mimeType: 'image/png' },
          ],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- web_vitals ---
  server.tool(
    'web_vitals',
    'Read Core Web Vitals collected since page load: CLS, LCP, FCP, TTFB, long tasks, max event duration (INP approximation). Requires the instrumentation content script (loaded at document_start).',
    {
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.WEB_VITALS, { tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- list_event_listeners ---
  server.tool(
    'list_event_listeners',
    'List event listeners registered via addEventListener since page load (type, target, capture/once/passive). Counts by type plus the most recent entries.',
    {
      type: z.string().optional().describe('Filter by event type (e.g. "click")'),
      limit: z.number().optional().default(100).describe('Max listener entries returned'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ type, limit, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.LIST_EVENT_LISTENERS, { type, limit, tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- monitor_websocket ---
  server.tool(
    'monitor_websocket',
    'Monitor WebSocket connections and messages (both directions, 500-char previews). First call installs the hook; connections opened before that are not captured.',
    {
      clear: z.boolean().optional().default(false).describe('Clear captured events after reading'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ clear, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.MONITOR_WEBSOCKET, { clear, tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- seo_audit ---
  server.tool(
    'seo_audit',
    'SEO audit: title/description lengths, canonical, robots, h1 count, Open Graph, Twitter card, JSON-LD validity, hreflang, lang, viewport, favicon',
    {
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.SEO_AUDIT, { tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- extract_table ---
  server.tool(
    'extract_table',
    'Extract an HTML table as structured JSON (headers from thead, rows as objects). Use index to pick among multiple tables.',
    {
      selector: z.string().optional().default('table').describe('CSS selector for tables'),
      index: z.number().optional().default(0).describe('Which matching table to extract (0-based)'),
      max_rows: z.number().optional().default(100).describe('Max rows returned'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ selector, index, max_rows, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.EXTRACT_TABLE, { selector, index, max_rows, tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- unused_css ---
  server.tool(
    'unused_css',
    'Find CSS selectors with no matching element in the current DOM (approximate — dynamic states and JS-toggled classes can cause false positives). Cross-origin stylesheets are not readable.',
    {
      max_selectors: z.number().optional().default(200).describe('Max unused selectors listed'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ max_selectors, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.UNUSED_CSS, { max_selectors, tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- drag_and_drop ---
  server.tool(
    'drag_and_drop',
    'Drag an element onto another. mode html5 = DragEvent sequence with DataTransfer (native DnD APIs); mode pointer = pointer/mouse event sequence (sortable libraries).',
    {
      source_selector: z.string().describe('CSS selector of the element to drag'),
      target_selector: z.string().describe('CSS selector of the drop target'),
      mode: z.enum(['html5', 'pointer']).optional().default('html5').describe('Event strategy'),
      frame_id: z.number().optional().describe('Frame ID (from get_frames; default: main frame)'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ source_selector, target_selector, mode, frame_id, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.DRAG_AND_DROP, { source_selector, target_selector, mode, frame_id, tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- clipboard ---
  server.tool(
    'clipboard',
    'Read or write the system clipboard (text). Activates the tab first; uses the Clipboard API with execCommand fallback.',
    {
      action: z.enum(['read', 'write']).describe('Clipboard operation'),
      text: z.string().optional().describe('Text to write (for write action)'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ action, text, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.CLIPBOARD, { action, text, tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- set_geolocation ---
  server.tool(
    'set_geolocation',
    'Override navigator.geolocation with fixed coordinates (page-level patch; pages holding earlier references are unaffected). reset restores native behavior.',
    {
      latitude: z.number().optional().describe('Latitude'),
      longitude: z.number().optional().describe('Longitude'),
      accuracy: z.number().optional().default(10).describe('Accuracy in meters'),
      reset: z.boolean().optional().default(false).describe('Restore native geolocation'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ latitude, longitude, accuracy, reset, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.SET_GEOLOCATION, { latitude, longitude, accuracy, reset, tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- manage_downloads ---
  server.tool(
    'manage_downloads',
    'List recent downloads or wait for an in-progress/new download to complete (e.g. after clicking an export button). Files land in the ChromeOS Downloads folder, not the server filesystem.',
    {
      action: z.enum(['list', 'wait_for_complete']).describe('Operation'),
      timeout: z.number().optional().default(30000).describe('Max wait in ms (wait_for_complete)'),
      limit: z.number().optional().default(10).describe('Max items returned (list)'),
    },
    async ({ action, timeout, limit }) => {
      const data = await wsManager.sendCommand(MessageType.MANAGE_DOWNLOADS, { action, timeout, limit });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- save_page ---
  server.tool(
    'save_page',
    'Save the full page (DOM, styles, images) as an MHTML archive file on the server filesystem.',
    {
      output_path: z.string().describe('Absolute file path to write (e.g. /tmp/page.mhtml)'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ output_path, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.SAVE_PAGE, { tab_id });
      await writeFile(output_path, Buffer.from(data.mhtml_b64, 'base64'));
      return { content: [{ type: 'text', text: JSON.stringify({ saved: output_path, size: data.size }, null, 2) }] };
    }
  );

  // --- set_zoom ---
  server.tool(
    'set_zoom',
    'Get or set the tab zoom factor (0.25–5). Call without factor to read current zoom; reset restores default.',
    {
      factor: z.number().optional().describe('Zoom factor (1 = 100%)'),
      reset: z.boolean().optional().default(false).describe('Restore default zoom'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ factor, reset, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.SET_ZOOM, { factor, reset, tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- http_auth ---
  server.tool(
    'http_auth',
    'Provide credentials for HTTP Basic/Digest auth dialogs (browser-wide until cleared). Credentials are kept in extension memory only.',
    {
      action: z.enum(['set', 'clear']).describe('set credentials or clear them'),
      username: z.string().optional().describe('Username (for set)'),
      password: z.string().optional().describe('Password (for set)'),
    },
    async ({ action, username, password }) => {
      if (action === 'set' && !username) throw new Error('username is required for action=set');
      const data = await wsManager.sendCommand(MessageType.HTTP_AUTH, { action, username, password });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- security_headers ---
  server.tool(
    'security_headers',
    'Audit HTTP security headers of the current page (CSP, HSTS, X-Content-Type-Options, clickjacking protection, Referrer-Policy, Permissions-Policy, version leaks). Headers are captured from real navigations — reload the page if none are available.',
    {
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.GET_RESPONSE_HEADERS, { tab_id });
      if (!data.available) {
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }
      const result = evaluateSecurityHeaders(data.headers, data.url);
      result.status = data.status;
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- session_fixture ---
  server.tool(
    'session_fixture',
    'Save or restore a session fixture (localStorage + sessionStorage + cookies) as a named JSON file under ~/.config/chrome-bridge/sessions/. Useful to snapshot a logged-in state and restore it later. Restore overwrites existing keys but does not clear others. The fixture records the page origin at save time; restore refuses to run if the current tab is on a different origin (navigate there first).',
    {
      action: z.enum(['save', 'restore', 'list']).describe('Operation'),
      name: z.string().optional().describe('Fixture name (required for save/restore)'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ action, name, tab_id }) => {
      if (action === 'list') {
        const { readdir } = await import('node:fs/promises');
        let files = [];
        try { files = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith('.json')); } catch {}
        return { content: [{ type: 'text', text: JSON.stringify({ fixtures: files.map((f) => f.replace(/\.json$/, '')) }, null, 2) }] };
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
        await writeFile(file, JSON.stringify({ savedAt: new Date().toISOString(), origin, ...data }, null, 2));
        return { content: [{ type: 'text', text: JSON.stringify({ saved: name, origin, localStorage: Object.keys(data.localStorage || {}).length, sessionStorage: Object.keys(data.sessionStorage || {}).length, cookies: (data.cookies || []).length }, null, 2) }] };
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
      return { content: [{ type: 'text', text: JSON.stringify({ restored: name, ...restored }, null, 2) }] };
    }
  );

  // --- get_interactives ---
  server.tool(
    'get_interactives',
    'List actionable elements (buttons, links, inputs, [role], [onclick]) with a ready-to-use CSS selector, label, position, enabled/visible/occluded flags. Use this to discover selectors instead of dumping the full HTML.',
    {
      scope: z.string().optional().describe('CSS selector to limit the search (default: whole document)'),
      limit: z.number().optional().default(100).describe('Max elements returned'),
      visible_only: z.boolean().optional().default(true).describe('Only return visible elements'),
      frame_id: z.number().optional().describe('Frame ID (from get_frames; default: main frame)'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ scope, limit, visible_only, frame_id, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.GET_INTERACTIVES, { scope, limit, visible_only, frame_id, tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- wait_for_function ---
  server.tool(
    'wait_for_function',
    'Poll a JavaScript expression in the page until it evaluates truthy or times out (generalizes wait_for_element). E.g. "window.app && app.ready" or "document.querySelectorAll(\'.row\').length > 10".',
    {
      expression: z.string().describe('JS expression evaluated in page context; resolves when truthy'),
      timeout: z.number().optional().default(10000).describe('Max wait in ms'),
      polling_ms: z.number().optional().default(100).describe('Poll interval in ms (min 50)'),
      frame_id: z.number().optional().describe('Frame ID (from get_frames; default: main frame)'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ expression, timeout, polling_ms, frame_id, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.WAIT_FOR_FUNCTION, { expression, timeout, polling_ms, frame_id, tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // --- scroll_until ---
  server.tool(
    'scroll_until',
    'Scroll the page repeatedly until a condition: an element becomes visible, the network goes idle, no new content loads, or the page bottom is reached. For infinite-scroll / lazy-loaded pages.',
    {
      until: z.enum(['element', 'network_idle', 'no_new_content']).optional().default('no_new_content').describe('Stop condition'),
      selector: z.string().optional().describe('Element selector (for until=element)'),
      max_scrolls: z.number().optional().default(20).describe('Max scroll steps'),
      step_px: z.number().optional().describe('Pixels per step (default: viewport height)'),
      settle_ms: z.number().optional().default(400).describe('Pause after each scroll in ms'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ until, selector, max_scrolls, step_px, settle_ms, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.SCROLL_UNTIL, { until, selector, max_scrolls, step_px, settle_ms, tab_id });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );
}
