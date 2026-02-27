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
}
