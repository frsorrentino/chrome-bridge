/**
 * Registra i tool MCP sul server.
 *
 * Ogni tool crea un comando WebSocket, lo invia tramite il WSManager
 * e restituisce il risultato al client MCP.
 */

import { z } from 'zod';
import { MessageType } from './protocol.js';

/**
 * Registra tutti i tool MCP.
 *
 * @param {import('@modelcontextprotocol/sdk/server/index.js').McpServer} server - MCP Server
 * @param {import('./ws-manager.js').WSManager} wsManager - WebSocket manager
 */
export function registerTools(server, wsManager) {

  // --- get_status ---
  server.tool(
    'get_status',
    'Check if the Chrome extension is connected',
    {},
    async () => {
      const connected = wsManager.isConnected();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ connected }, null, 2),
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
    'Take a screenshot of a Chrome tab (returns base64 PNG image)',
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
      code:   z.string().describe('JavaScript code to execute'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ code, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.EXECUTE_JS, { code, tab_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // --- click ---
  server.tool(
    'click',
    'Click on an element identified by CSS selector',
    {
      selector: z.string().describe('CSS selector of the element to click'),
      tab_id:   z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ selector, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.CLICK, { selector, tab_id });
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
    'Type text into an input element identified by CSS selector',
    {
      selector: z.string().describe('CSS selector of the input element'),
      text:     z.string().describe('Text to type'),
      tab_id:   z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ selector, text, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.TYPE_TEXT, { selector, text, tab_id });
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
      mode:   z.enum(['text', 'html', 'accessibility']).default('text').describe('Content mode: text (visible text), html (full HTML), accessibility (a11y tree)'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ mode, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.READ_PAGE, { mode, tab_id });
      return {
        content: [{
          type: 'text',
          text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
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
    },
    async ({ tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.GET_PAGE_INFO, { tab_id });
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
    'Query DOM elements by CSS selector, returning structure, attributes, bounding rect, and computed styles',
    {
      selector: z.string().describe('CSS selector to query'),
      properties: z.array(z.string()).optional().describe('Computed style properties to include (e.g. ["color", "font-size"])'),
      limit: z.number().optional().default(50).describe('Max elements to return (default 50)'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ selector, properties, limit, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.QUERY_DOM, { selector, properties, limit, tab_id });
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
    },
    async ({ selector, action, name, value, className, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.MODIFY_DOM, { selector, action, name, value, className, tab_id });
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
    'Read captured console messages (log, warn, error, info, debug). First call installs the capture hook; subsequent calls read accumulated messages.',
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
    'Monitor network requests (XHR and fetch). First call installs the capture hook; subsequent calls read accumulated requests.',
    {
      clear: z.boolean().optional().default(false).describe('Clear captured requests after reading'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ clear, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.MONITOR_NETWORK, { clear, tab_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
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
    'Wait for a CSS selector to appear in the DOM, with optional visibility check. Polls until found or timeout.',
    {
      selector: z.string().describe('CSS selector to wait for'),
      timeout: z.number().optional().default(10000).describe('Max wait time in ms (default 10000)'),
      interval: z.number().optional().default(200).describe('Poll interval in ms (default 200, min 50)'),
      visible: z.boolean().optional().default(false).describe('Also require the element to be visible'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ selector, timeout, interval, visible, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.WAIT_FOR_ELEMENT, { selector, timeout, interval, visible, tab_id });
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
    },
    async ({ selector, x, y, behavior, offset_y, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.SCROLL_TO, { selector, x, y, behavior, offset_y, tab_id });
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
    },
    async ({ fields, submit_selector, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.FILL_FORM, { fields, submit_selector, tab_id });
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

  // --- full_page_screenshot ---
  server.tool(
    'full_page_screenshot',
    'Capture full page by scrolling and taking multiple viewport screenshots. Returns array of PNG images.',
    {
      max_scrolls: z.number().optional().default(20).describe('Max scroll steps (default 20)'),
      delay: z.number().optional().default(200).describe('Delay between captures in ms (default 200)'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ max_scrolls, delay, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.FULL_PAGE_SCREENSHOT, { max_scrolls, delay, tab_id });
      // data.captures is array of base64 PNGs
      const content = [{ type: 'text', text: `Full page screenshot: ${data.captures?.length || 0} captures, scrollHeight=${data.scrollHeight}, viewportHeight=${data.viewportHeight}` }];
      if (data.captures && data.captures.length > 0) {
        for (const img of data.captures) {
          content.push({ type: 'image', data: img, mimeType: 'image/png' });
        }
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
    'Run accessibility audit: missing alt, empty links, heading hierarchy, ARIA issues, contrast, form labels',
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
    'Check all links on the page for broken URLs (HTTP status >= 400). Supports scope filtering.',
    {
      scope: z.enum(['same-origin', 'all', 'external']).optional().default('all').describe('Link scope: same-origin, external, or all'),
      selector: z.string().optional().default('a[href]').describe('CSS selector to find links (default: a[href])'),
      timeout: z.number().optional().default(5000).describe('Per-link fetch timeout in ms'),
      max_links: z.number().optional().default(50).describe('Max links to check'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ scope, selector, timeout, max_links, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.CHECK_LINKS, { scope, selector, timeout, max_links, tab_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
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
    'Hover over an element identified by CSS selector. Dispatches mouseenter and mouseover events.',
    {
      selector: z.string().describe('CSS selector of the element to hover'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ selector, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.HOVER, { selector, tab_id });
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
    'Press a keyboard key with optional modifiers. Dispatches keydown, keypress (for printable), and keyup events.',
    {
      key: z.string().describe('Key to press (e.g. "Enter", "Escape", "Tab", "a", "ArrowDown")'),
      selector: z.string().optional().describe('CSS selector of element to target (default: document.activeElement)'),
      ctrl: z.boolean().optional().default(false).describe('Hold Ctrl'),
      shift: z.boolean().optional().default(false).describe('Hold Shift'),
      alt: z.boolean().optional().default(false).describe('Hold Alt'),
      meta: z.boolean().optional().default(false).describe('Hold Meta/Cmd'),
      tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
    },
    async ({ key, selector, ctrl, shift, alt, meta, tab_id }) => {
      const data = await wsManager.sendCommand(MessageType.PRESS_KEY, { key, selector, ctrl, shift, alt, meta, tab_id });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );
}
