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
import { DEFAULT_PORT } from './protocol.js';

const PORT = parseInt(process.env.CHROME_BRIDGE_PORT || DEFAULT_PORT, 10);

async function main() {
  // 1. Crea il server MCP
  const mcpServer = new McpServer({
    name: 'chrome-bridge',
    version: '1.0.0',
  });

  // 2. Avvia il WebSocket server
  const wsManager = new WSManager(PORT);
  await wsManager.start();

  // 3. Registra i tool MCP
  registerTools(mcpServer, wsManager);

  // 4. Avvia il trasporto stdio MCP
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error('[chrome-bridge] MCP server ready (stdio + WebSocket)');

  // 5. Graceful shutdown
  const shutdown = async () => {
    console.error('[chrome-bridge] Shutting down...');
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
