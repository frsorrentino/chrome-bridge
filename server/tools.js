/**
 * Registra i tool MCP sul server.
 *
 * Ogni tool crea un comando WebSocket, lo invia tramite il WSManager
 * e restituisce il risultato al client MCP.
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { z } from 'zod';
import { MessageType, VERSION } from './protocol.js';
import { checkLinksBatch } from './link-checker.js';
import { toHar } from './har.js';

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
      tab_id:   z.number().optional().describe('Tab ID (default: active tab)'),
      frame_id: z.number().optional().describe('Frame ID to target (from get_frames; default: main frame)'),
    },
    async ({ selector, tab_id, frame_id }) => {
      const data = await wsManager.sendCommand(MessageType.CLICK, { selector, tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
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
      tab_id:   z.number().optional().describe('Tab ID (default: active tab)'),
      frame_id: z.number().optional().describe('Frame ID to target (from get_frames; default: main frame)'),
    },
    async ({ selector, text, tab_id, frame_id }) => {
      const data = await wsManager.sendCommand(MessageType.TYPE_TEXT, { selector, text, tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
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
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ type, action, key, value, path, domain, expires, secure, sameSite, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.SET_STORAGE, { type, action, key, value, path, domain, expires, secure, sameSite, tab_id });
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
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
      frame_id: z.number().optional().describe('Frame ID to target (from get_frames; default: main frame)'),
    },
    async ({ fields, submit_selector, tab_id, frame_id }) => {
      const data = await wsManager.sendCommand(MessageType.FILL_FORM, { fields, submit_selector, tab_id, frame_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
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
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ timeout, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.WAIT_FOR_NAVIGATION, { timeout, tab_id });
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
}
