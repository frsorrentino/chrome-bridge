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
import { createObserver } from './observe.js';
import { BRANDED_CHROME_HINT, launchBrowser } from './launcher.js';
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

// Capability: default = solo set core. --caps audits,visual o
// CHROME_BRIDGE_CAPS attivano i gruppi opt-in; "all" registra tutto.
// Interruttori di sicurezza (README, «Configuration and security»).
function parseSecurity() {
  const on = (v) => v != null && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  return {
    noJs: process.argv.includes('--no-js') || on(process.env.CHROME_BRIDGE_NO_JS),
    writeRoot: argValue('--write-root') ?? process.env.CHROME_BRIDGE_WRITE_ROOT ?? null,
    readRoot: argValue('--read-root') ?? process.env.CHROME_BRIDGE_READ_ROOT ?? null,
  };
}

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
    // get_status({enable}) accende N tool uno per uno: una sola notifica,
    // non N (un ciclo di list_changed costava CPU a Claude Code, 2.1.271).
    debouncedNotificationMethods: ['notifications/tools/list_changed'],
    instructions: [
      // Eval del 29/09: con Claude in Chrome richiesto e assente, il modello
      // ripiegava su chrome-bridge senza chiedere (2 casi su 2).
      'If the user names another browser tool (e.g. Claude in Chrome) and it is not available, say so and ask; do not switch to chrome-bridge on your own.',
      'Selectors on DOM tools pierce shadow DOM with ">>>" ("my-app >>> button.save").',
      'tab_id omitted = the tab last navigated/created in this session, else the active tab. frame_id omitted = main frame (list frames with get_frames).',
      'To find targets use get_interactives, not read_page(html); its refs (n1, n2…) are the ref param of click/type_text/hover and of fill_form fields, and navigate already returns them.',
      // Il costo dominante sono i TURNI, non i byte: un turno vale ~15-30 volte
      // un KB di output risparmiato. Queste due clausole si pagano una volta
      // qui e valgono più di qualunque ottimizzazione di schema.
      'Several fields: one fill_form (submit_selector submits in the same call), not repeated type_text: one turn instead of N.',
      'Tables: extract_table (where/columns filtered server-side) or extract, never read_page: a big table through read_page costs tens of thousands of tokens.',
      // Debug del 29/09: in 7 run su 20 il modello caricava la skill prima di
      // agire e pagava ~2 turni. La regola che serve sta qui, già in contesto.
      'Debugging a page: navigate already reports the first console error mapped to its source line and the failed requests with status; get_css_styles names the rule behind a style and flags undefined_vars. Start there; no skill or recipe needed.',
      'Detail in a screenshot: element_screenshot (selector or region, scale), not another full one. To check an outcome: assert or wait_for poll for you, no screenshot.',
      // Il blocco più frequente sul campo (Meta Ads Manager, 23/09/2026): tre
      // attese scadute e due screenshot falliti prima di capire che la
      // finestra era dietro un'altra.
      // Il 42% delle sessioni reali caricava i tool con 2+ ToolSearch (media 2,0).
      'When tools are deferred, batch every tool needed for the next workflow into ONE ToolSearch call using exact names (select:name1,name2,...); do not search one tool at a time.',
      'Missing optional tools: call get_status({enable:["group",...]}) once for all required groups (audits, visual, network, storage, dom, files; "all" enables all). After tools/list_changed, use them next turn; if still deferred, batch-search their names once. No restart or user configuration needed.',
      'A tab in a minimized, covered or background window does not render: screenshots fail, timers slow down. get_page_info reports visibility (page_hidden in a result means the same); bring the window on screen, or create_tab new_window with bounds.',
    ].join(' '),
  });

  // 2. Avvia il WebSocket server
  // Con --launch l'estensione arriva solo dopo l'avvio a freddo di Chrome: su
  // una macchina carica servono decine di secondi, non i 10 s del default.
  const wsManager = new WSManager(PORT, { host: HOST, ...(LAUNCH && !process.env.CHROME_BRIDGE_CONNECT_WAIT_MS && { connectWait: 30000 }) });
  await wsManager.start();

  // 2b. Launch mode: browser dedicato che si connette alla nostra porta.
  // Gli handler di shutdown sono registrati PRIMA del launch: registrarli dopo
  // lasciava Chromium e il profilo temporaneo orfani a ogni segnale ricevuto
  // durante l'avvio (osservate 3 directory residue, una da 122 MB).
  let browser = null;
  const session = { tools: null };
  const shutdown = async () => {
    console.error('[chrome-bridge] Shutting down...');
    try { await Promise.race([session.tools?.closeEmptyOwnedTabs(), new Promise((r) => setTimeout(r, 2000))]); } catch {}
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
    // Il Chrome brandizzato parte ma resta muto: l'errore di connessione dice perche'
    if (browser.branded) wsManager.notConnectedHint = BRANDED_CHROME_HINT;
  }

  // 3. Registra i tool MCP (filtrati per capability)
  // Errori dei tool annotati in locale (formato claude-observe) quando nessun
  // hook del plugin li vede: vedi server/observe.js.
  const observe = createObserver({ version: VERSION });
  session.tools = registerTools(mcpServer, wsManager, parseCaps(), { ...parseSecurity(), observe });

  // 4. Avvia il trasporto stdio MCP
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error(`[chrome-bridge] MCP server ready (stdio + WebSocket, mode: ${wsManager.mode})`);

}

main().catch((err) => {
  console.error('[chrome-bridge] Fatal error:', err);
  process.exit(1);
});
