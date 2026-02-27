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
 * @param {import('@modelcontextprotocol/sdk/server/index.js').Server} server - MCP Server
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
}
