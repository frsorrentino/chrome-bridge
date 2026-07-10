#!/usr/bin/env node

/**
 * Chrome Bridge MCP Server
 *
 * Entry point che avvia:
 * 1. Il server WebSocket (per comunicare con l'estensione Chrome)
 * 2. Il server MCP (per comunicare con Claude Code via stdio)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WSManager } from './ws-manager.js';
import { registerTools } from './tools.js';
import { launchBrowser } from './launcher.js';
import { DEFAULT_PORT, VERSION } from './protocol.js';

// Launch mode: browser dedicato (profilo effimero + estensione unpacked).
// Porta effimera di default: zero conflitti con un bridge già attivo.
const LAUNCH = process.argv.includes('--launch');
const HEADLESS = process.argv.includes('--headless');
const PORT = process.env.CHROME_BRIDGE_PORT
  ? parseInt(process.env.CHROME_BRIDGE_PORT, 10)
  : (LAUNCH ? 0 : DEFAULT_PORT);

// Capability: default = solo set core (28 tool). --caps audits,visual o
// CHROME_BRIDGE_CAPS attivano i gruppi opt-in; "all" registra tutto.
function parseCaps() {
  const i = process.argv.indexOf('--caps');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env.CHROME_BRIDGE_CAPS || 'core';
}

async function main() {
  // 1. Crea il server MCP
  // instructions: dette una volta qui invece che ripetute in ogni descrizione
  // tool — pesano ~1 volta nel contesto del client anziché ~50.
  const mcpServer = new McpServer({
    name: 'chrome-bridge',
    version: VERSION,
  }, {
    instructions: [
      'Selector parameters on DOM tools support shadow-DOM piercing with ">>>" (e.g. "my-app >>> button.save").',
      'tab_id omitted = the tab last navigated/created in this session, else the active tab. frame_id omitted = main frame (list frames with get_frames).',
      'Prefer get_interactives over read_page(html) to discover targets; its refs (n1, n2…) work as the ref param of click/type_text/hover.',
    ].join(' '),
  });

  // 2. Avvia il WebSocket server
  const wsManager = new WSManager(PORT);
  await wsManager.start();

  // 2b. Launch mode: browser dedicato che si connette alla nostra porta
  let browser = null;
  if (LAUNCH) {
    if (wsManager.mode !== 'primary') {
      throw new Error(`--launch requires a dedicated port, but ${wsManager.port} is owned by another chrome-bridge. Unset CHROME_BRIDGE_PORT (ephemeral) or pick a free one.`);
    }
    browser = await launchBrowser({ port: wsManager.port, headless: HEADLESS });
  }

  // 3. Registra i tool MCP (filtrati per capability)
  registerTools(mcpServer, wsManager, parseCaps());

  // 4. Avvia il trasporto stdio MCP
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error(`[chrome-bridge] MCP server ready (stdio + WebSocket, mode: ${wsManager.mode})`);

  // 5. Graceful shutdown
  const shutdown = async () => {
    console.error('[chrome-bridge] Shutting down...');
    if (browser) await browser.stop();
    await wsManager.stop();
    await mcpServer.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[chrome-bridge] Fatal error:', err);
  process.exit(1);
});
