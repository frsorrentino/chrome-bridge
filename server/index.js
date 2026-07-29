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
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
// Bind: loopback di default, 0.0.0.0 solo su richiesta esplicita (Crostini).
const HOST = argValue('--host') ?? process.env.CHROME_BRIDGE_HOST ?? '127.0.0.1';
const PORT = process.env.CHROME_BRIDGE_PORT
  ? parseInt(process.env.CHROME_BRIDGE_PORT, 10)
  : (LAUNCH ? 0 : DEFAULT_PORT);

// Capability: default = solo set core (30 tool). --caps audits,visual o
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
      // Il costo dominante sono i TURNI, non i byte: un turno vale ~15-30 volte
      // un KB di output risparmiato. Queste due clausole si pagano una volta
      // qui e valgono più di qualunque ottimizzazione di schema.
      'For more than one field use fill_form once (with submit_selector to submit in the same call) instead of repeated type_text: one turn instead of N.',
      'For tables use extract_table (server-side where/columns filtering) or extract, never read_page: read_page on a big table costs tens of thousands of tokens for data you filter anyway.',
    ].join(' '),
  });

  // 2. Avvia il WebSocket server
  const wsManager = new WSManager(PORT, { host: HOST });
  await wsManager.start();

  // 2b. Launch mode: browser dedicato che si connette alla nostra porta.
  // Gli handler di shutdown sono registrati PRIMA del launch: registrarli dopo
  // lasciava Chromium e il profilo temporaneo orfani a ogni segnale ricevuto
  // durante l'avvio (osservate 3 directory residue, una da 122 MB).
  let browser = null;
  const shutdown = async () => {
    console.error('[chrome-bridge] Shutting down...');
    try { if (browser) await browser.stop(); } catch {}
    try { await wsManager.stop(); } catch {}
    try { await mcpServer.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    console.error('[chrome-bridge] Uncaught exception:', err);
    shutdown().catch(() => process.exit(1));
  });
  process.on('unhandledRejection', (err) => {
    console.error('[chrome-bridge] Unhandled rejection:', err);
  });

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

}

main().catch((err) => {
  console.error('[chrome-bridge] Fatal error:', err);
  process.exit(1);
});
