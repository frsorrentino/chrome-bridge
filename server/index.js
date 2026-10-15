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
import { INSTRUCTIONS } from './instructions.js';
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
    alwaysLoad: argValue('--always-load') ?? process.env.CHROME_BRIDGE_ALWAYS_LOAD ?? null,
  };
}

function parseCaps() {
  const i = process.argv.indexOf('--caps');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env.CHROME_BRIDGE_CAPS || 'core';
}

async function main() {
  // 1. Crea il server MCP (istruzioni e loro limiti in instructions.js)
  const mcpServer = new McpServer({
    name: 'chrome-bridge',
    version: VERSION,
  }, {
    // get_status({enable}) accende N tool uno per uno: una sola notifica,
    // non N (un ciclo di list_changed costava CPU a Claude Code, 2.1.271).
    debouncedNotificationMethods: ['notifications/tools/list_changed'],
    instructions: INSTRUCTIONS,
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
  // Una sola chiusura anche quando fine di stdin, chiusura del trasporto e
  // segnale arrivano insieme.
  let closing = null;
  const shutdown = () => (closing ??= (async () => {
    console.error('[chrome-bridge] Shutting down...');
    // Il browser di --launch per primo: su Windows Claude Code chiude stdin e
    // dopo 300 ms uccide l'albero dei processi (2.1.296). Le sue schede
    // muoiono con lui; nel Chrome dell'utente si chiudono quelle rimaste vuote.
    if (browser) {
      try { await browser.stop(); } catch {}
    } else {
      try { await Promise.race([session.tools?.closeEmptyOwnedTabs(), new Promise((r) => setTimeout(r, 2000))]); } catch {}
    }
    try { await wsManager.stop(); } catch {}
    try { await mcpServer.close(); } catch {}
    process.exit(0);
  })());
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Su Windows SIGINT e SIGTERM non arrivano, e un client terminato di colpo
  // non manda segnali: in entrambi i casi resta solo la fine di stdin. L'SDK
  // non la ascolta, e il WebSocket teneva vivo il processo.
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  mcpServer.server.onclose = shutdown;
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
  session.tools = registerTools(mcpServer, wsManager, parseCaps(), { ...parseSecurity(), observe, cdpPort: browser ? browser.cdpPort : null });

  // 4. Avvia il trasporto stdio MCP
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error(`[chrome-bridge] MCP server ready (stdio + WebSocket, mode: ${wsManager.mode})`);

}

main().catch((err) => {
  console.error('[chrome-bridge] Fatal error:', err);
  process.exit(1);
});
