# Chrome Browser Bridge — Piano di Implementazione (storico)

> **SUPERSEDED — documento storico del 2026-02-27, NON eseguire.**
> Il piano è stato interamente implementato e poi superato: i blocchi
> "Implementazione completa" qui sotto contengono la versione a 8 tool di
> `server/tools.js` (oggi 59) e la vecchia forma di `ws-manager.js`.
> Applicarli regredirebbe il prodotto. Conservato solo come traccia delle
> decisioni di design originali.


**Goal:** Creare un bridge WebSocket che permette a Claude Code (in Crostini/Linux) di controllare Chrome (su ChromeOS) tramite MCP tools.

**Architecture:** Un MCP server Node.js espone tool (navigate, screenshot, execute_js, click, type_text, read_page, get_tabs, get_status) via stdio transport. Il server mantiene un WebSocket su porta 8765 a cui si connette un'estensione Chrome MV3. ChromeOS inoltra automaticamente le porte di Crostini, quindi l'estensione raggiunge il server a `ws://localhost:8765`.

**Tech Stack:** Node.js, @modelcontextprotocol/sdk, ws, Chrome Extension Manifest V3

---

## Contesto

Claude Code gira in Crostini (container Linux su ChromeOS), Chrome gira nativamente su ChromeOS. L'estensione "Claude in Chrome" non riesce a collegarsi attraverso questo confine perché il native messaging non funziona cross-container. Serve un bridge WebSocket custom: ChromeOS inoltra automaticamente le porte di Crostini a ChromeOS, quindi un server WebSocket avviato in Crostini è raggiungibile da Chrome a `localhost:PORT`.

## Diagramma Architetturale

```
Claude Code (Crostini)              Chrome (ChromeOS)
  │                                      │
  │── chiama tool MCP ──► [Node.js MCP Server]
                              │  (stdio transport)
                              │
                         [WebSocket Server :8765]
                              │
                              │ ws://localhost:8765
                              │ (port forwarded da ChromeOS)
                              │
                         [Chrome Extension MV3]
                              │
                         [Chrome APIs]
```

**Perché Node.js** (non Python):
- MCP SDK Node.js è il reference implementation ufficiale
- `ws` è puro JS, nessun problema con architettura aarch64
- Stesso linguaggio dell'estensione Chrome
- Node.js già disponibile nell'ambiente

## Struttura File

**Directory di lavoro:** `~/.claude/chrome-bridge/`

```
~/.claude/chrome-bridge/
├── package.json
├── server/
│   ├── index.js            # Entry point: MCP stdio + WebSocket server
│   ├── tools.js            # Definizioni tool MCP
│   ├── ws-manager.js       # Gestione connessione WebSocket
│   └── protocol.js         # Costanti protocollo e helper
├── extension/
│   ├── manifest.json       # Manifest V3
│   ├── service-worker.js   # WebSocket client + Chrome API executor
│   ├── popup.html          # UI stato connessione
│   ├── popup.js
│   ├── popup.css
│   └── icons/              # Icone 16/48/128px
└── README.md
```

## Tool MCP Esposti

| Tool | Descrizione | Parametri |
|------|-------------|-----------|
| `get_status` | Verifica connessione estensione | nessuno |
| `navigate` | Naviga a un URL in un tab | `url` (string, required), `tab_id` (number, optional) |
| `screenshot` | Screenshot del tab attivo | `tab_id` (number, optional) |
| `execute_js` | Esegue JavaScript nella pagina | `code` (string, required), `tab_id` (number, optional) |
| `click` | Click su elemento via CSS selector | `selector` (string, required), `tab_id` (number, optional) |
| `type_text` | Digita testo in un input | `selector` (string, required), `text` (string, required), `tab_id` (number, optional) |
| `read_page` | Legge contenuto pagina | `mode` (string: "text"\|"html"\|"accessibility", default "text"), `tab_id` (number, optional) |
| `get_tabs` | Lista tab aperti | nessuno |

## Protocollo WebSocket

**Comando** (server → extension):
```json
{
  "id": "msg_1_1234567890",
  "type": "navigate",
  "params": {"url": "https://example.com"},
  "timestamp": 1234567890
}
```

**Risposta** (extension → server):
```json
{
  "id": "msg_1_1234567890",
  "type": "result",
  "data": {"url": "https://example.com", "title": "Example"},
  "timestamp": 1234567891
}
```

**Errore** (extension → server):
```json
{
  "id": "msg_1_1234567890",
  "type": "error",
  "error": "Tab not found",
  "timestamp": 1234567891
}
```

**Heartbeat:** ping/pong ogni 15 secondi. Timeout comandi: 30s (screenshot: 10s).

---

## Task di Implementazione

### Task 1: Scaffold progetto e dipendenze

**Files:**
- Create: `~/.claude/chrome-bridge/package.json`

**Step 1: Creare la directory del progetto**
```bash
mkdir -p ~/.claude/chrome-bridge/server ~/.claude/chrome-bridge/extension/icons
```

**Step 2: Creare package.json**
```json
{
  "name": "chrome-bridge",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "MCP server bridge between Claude Code (Crostini) and Chrome (ChromeOS) via WebSocket",
  "main": "server/index.js",
  "scripts": {
    "start": "node server/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "ws": "^8.18.0"
  }
}
```

**Step 3: Installare le dipendenze**
```bash
cd ~/.claude/chrome-bridge && npm install
```

**Step 4: Commit**
```bash
cd ~/.claude/chrome-bridge && git init && git add -A && git commit -m "chore: scaffold project with MCP SDK and ws dependencies"
```

---

### Task 2: Server — protocol.js

**Files:**
- Create: `~/.claude/chrome-bridge/server/protocol.js`

**Implementazione completa:**

```javascript
/**
 * Costanti del protocollo e helper per la comunicazione WebSocket.
 */

// Tipi di messaggi WebSocket
export const MessageType = Object.freeze({
  // Comandi (server → extension)
  NAVIGATE:   'navigate',
  SCREENSHOT: 'screenshot',
  EXECUTE_JS: 'execute_js',
  CLICK:      'click',
  TYPE_TEXT:   'type_text',
  READ_PAGE:  'read_page',
  GET_TABS:   'get_tabs',

  // Risposte (extension → server)
  RESULT: 'result',
  ERROR:  'error',

  // Heartbeat
  PING: 'ping',
  PONG: 'pong',
});

// Configurazione
export const DEFAULT_PORT          = 8765;
export const COMMAND_TIMEOUT_MS    = 30000;  // 30s per comandi normali
export const SCREENSHOT_TIMEOUT_MS = 10000;  // 10s per screenshot
export const PING_INTERVAL_MS     = 15000;  // 15s heartbeat

// Contatore globale per ID univoci
let messageCounter = 0;

/**
 * Crea un oggetto comando da inviare all'estensione.
 *
 * @param {string} type - Tipo di comando (da MessageType)
 * @param {object} params - Parametri del comando
 * @returns {object} Comando serializzabile in JSON
 */
export function createCommand(type, params = {}) {
  messageCounter += 1;
  return {
    id: `msg_${messageCounter}_${Date.now()}`,
    type,
    params,
    timestamp: Date.now(),
  };
}

/**
 * Restituisce il timeout appropriato per un tipo di comando.
 *
 * @param {string} type - Tipo di comando
 * @returns {number} Timeout in millisecondi
 */
export function getTimeout(type) {
  return type === MessageType.SCREENSHOT
    ? SCREENSHOT_TIMEOUT_MS
    : COMMAND_TIMEOUT_MS;
}
```

**Commit:**
```bash
git add server/protocol.js && git commit -m "feat: add WebSocket protocol constants and helpers"
```

---

### Task 3: Server — ws-manager.js

**Files:**
- Create: `~/.claude/chrome-bridge/server/ws-manager.js`

**Implementazione completa:**

```javascript
/**
 * Gestisce il server WebSocket e la connessione con l'estensione Chrome.
 *
 * - Accetta una sola connessione alla volta (nuova sostituisce la vecchia)
 * - Gestisce ping/pong heartbeat
 * - Invia comandi con promise + timeout
 */

import { WebSocketServer } from 'ws';
import { DEFAULT_PORT, PING_INTERVAL_MS, getTimeout, createCommand, MessageType } from './protocol.js';

export class WSManager {
  constructor(port = DEFAULT_PORT) {
    this.port = port;
    this.wss = null;
    this.client = null;         // Connessione attiva (una sola)
    this.pending = new Map();   // id → { resolve, reject, timer }
    this.pingInterval = null;
  }

  /**
   * Avvia il WebSocket server.
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({
        host: '127.0.0.1',
        port: this.port,
      });

      this.wss.on('listening', () => {
        console.error(`[chrome-bridge] WebSocket server listening on 127.0.0.1:${this.port}`);
        this._startPing();
        resolve();
      });

      this.wss.on('error', (err) => {
        console.error(`[chrome-bridge] WebSocket server error:`, err.message);
        reject(err);
      });

      this.wss.on('connection', (ws) => {
        console.error('[chrome-bridge] Chrome extension connected');

        // Chiudi connessione precedente se esiste
        if (this.client) {
          console.error('[chrome-bridge] Replacing existing connection');
          this.client.close(1000, 'Replaced by new connection');
        }

        this.client = ws;

        ws.on('message', (raw) => {
          this._handleMessage(raw);
        });

        ws.on('close', () => {
          console.error('[chrome-bridge] Chrome extension disconnected');
          if (this.client === ws) {
            this.client = null;
            this._rejectAllPending('Extension disconnected');
          }
        });

        ws.on('error', (err) => {
          console.error('[chrome-bridge] WebSocket client error:', err.message);
        });
      });
    });
  }

  /**
   * Verifica se l'estensione è connessa.
   * @returns {boolean}
   */
  isConnected() {
    return this.client !== null && this.client.readyState === 1; // WebSocket.OPEN
  }

  /**
   * Invia un comando all'estensione e attende la risposta.
   *
   * @param {string} type - Tipo di comando
   * @param {object} params - Parametri
   * @returns {Promise<any>} Dati della risposta
   */
  sendCommand(type, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject(new Error('Chrome extension not connected'));
        return;
      }

      const command = createCommand(type, params);
      const timeout = getTimeout(type);

      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        reject(new Error(`Command ${type} timed out after ${timeout}ms`));
      }, timeout);

      this.pending.set(command.id, { resolve, reject, timer });

      this.client.send(JSON.stringify(command));
    });
  }

  /**
   * Gestisce un messaggio ricevuto dall'estensione.
   */
  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.error('[chrome-bridge] Invalid JSON received');
      return;
    }

    // Gestisci pong heartbeat
    if (msg.type === MessageType.PONG) {
      return;
    }

    // Gestisci risposta a un comando pending
    const pending = this.pending.get(msg.id);
    if (!pending) {
      return;
    }

    this.pending.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.type === MessageType.ERROR) {
      pending.reject(new Error(msg.error || 'Unknown error from extension'));
    } else {
      pending.resolve(msg.data);
    }
  }

  /**
   * Avvia il ping heartbeat periodico.
   */
  _startPing() {
    this.pingInterval = setInterval(() => {
      if (this.isConnected()) {
        this.client.send(JSON.stringify({
          type: MessageType.PING,
          timestamp: Date.now(),
        }));
      }
    }, PING_INTERVAL_MS);
  }

  /**
   * Rifiuta tutte le richieste pending.
   */
  _rejectAllPending(reason) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /**
   * Chiude il server WebSocket.
   */
  async stop() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    this._rejectAllPending('Server shutting down');

    if (this.client) {
      this.client.close(1000, 'Server shutting down');
      this.client = null;
    }

    if (this.wss) {
      return new Promise((resolve) => {
        this.wss.close(() => resolve());
      });
    }
  }
}
```

**Commit:**
```bash
git add server/ws-manager.js && git commit -m "feat: add WebSocket manager with single-connection and heartbeat"
```

---

### Task 4: Server — tools.js

**Files:**
- Create: `~/.claude/chrome-bridge/server/tools.js`

**Implementazione completa:**

```javascript
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
```

**Nota:** `zod` è incluso come dipendenza transitiva di `@modelcontextprotocol/sdk`. Se non disponibile, aggiungere `"zod": "^3.23.0"` in package.json.

**Commit:**
```bash
git add server/tools.js && git commit -m "feat: register 8 MCP tools for Chrome browser control"
```

---

### Task 5: Server — index.js

**Files:**
- Create: `~/.claude/chrome-bridge/server/index.js`

**Implementazione completa:**

```javascript
#!/usr/bin/env node

/**
 * Chrome Bridge MCP Server
 *
 * Entry point che avvia:
 * 1. Il server WebSocket (per comunicare con l'estensione Chrome)
 * 2. Il server MCP (per comunicare con Claude Code via stdio)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WSManager } from './ws-manager.js';
import { registerTools } from './tools.js';
import { DEFAULT_PORT } from './protocol.js';

const PORT = parseInt(process.env.CHROME_BRIDGE_PORT || DEFAULT_PORT, 10);

async function main() {
  // 1. Crea il server MCP
  const server = new Server(
    {
      name: 'chrome-bridge',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // 2. Avvia il WebSocket server
  const wsManager = new WSManager(PORT);
  await wsManager.start();

  // 3. Registra i tool MCP
  registerTools(server, wsManager);

  // 4. Avvia il trasporto stdio MCP
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[chrome-bridge] MCP server ready (stdio + WebSocket)');

  // 5. Graceful shutdown
  const shutdown = async () => {
    console.error('[chrome-bridge] Shutting down...');
    await wsManager.stop();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[chrome-bridge] Fatal error:', err);
  process.exit(1);
});
```

**Commit:**
```bash
git add server/index.js && git commit -m "feat: add MCP server entry point with stdio + WebSocket"
```

---

### Task 6: Extension — manifest.json

**Files:**
- Create: `~/.claude/chrome-bridge/extension/manifest.json`

**Implementazione completa:**

```json
{
  "manifest_version": 3,
  "name": "Chrome Bridge for Claude Code",
  "version": "1.0.0",
  "description": "Connects Chrome to Claude Code via WebSocket bridge",
  "permissions": [
    "tabs",
    "activeTab",
    "scripting",
    "alarms"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "background": {
    "service_worker": "service-worker.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    }
  },
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

**Commit:**
```bash
git add extension/manifest.json && git commit -m "feat: add Chrome extension manifest V3"
```

---

### Task 7: Extension — service-worker.js

**Files:**
- Create: `~/.claude/chrome-bridge/extension/service-worker.js`

**Implementazione completa:**

```javascript
/**
 * Chrome Bridge — Service Worker
 *
 * Mantiene una connessione WebSocket al server MCP in Crostini.
 * Riceve comandi, li esegue tramite Chrome APIs, e invia le risposte.
 */

const WS_URL = 'ws://localhost:8765';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const KEEPALIVE_ALARM = 'chrome-bridge-keepalive';

let ws = null;
let reconnectDelay = RECONNECT_BASE_MS;
let connectionState = 'disconnected'; // 'connected' | 'connecting' | 'disconnected'

// --- Keep-alive: impedisce che il service worker venga fermato ---
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // ~24s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // Il solo fatto che l'handler esista tiene il service worker attivo
  }
});

// --- WebSocket connection ---

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setConnectionState('connecting');

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.error('[chrome-bridge] WebSocket creation error:', err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[chrome-bridge] Connected to MCP server');
    setConnectionState('connected');
    reconnectDelay = RECONNECT_BASE_MS; // Reset backoff
  };

  ws.onclose = () => {
    console.log('[chrome-bridge] Disconnected from MCP server');
    ws = null;
    setConnectionState('disconnected');
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[chrome-bridge] WebSocket error:', err);
    // onclose verrà chiamato dopo onerror
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.error('[chrome-bridge] Invalid JSON from server');
      return;
    }

    // Gestisci ping
    if (msg.type === 'ping') {
      sendMessage({ type: 'pong', timestamp: Date.now() });
      return;
    }

    // Esegui il comando e rispondi
    try {
      const result = await executeCommand(msg);
      sendMessage({
        id: msg.id,
        type: 'result',
        data: result,
        timestamp: Date.now(),
      });
    } catch (err) {
      sendMessage({
        id: msg.id,
        type: 'error',
        error: err.message || String(err),
        timestamp: Date.now(),
      });
    }
  };
}

function scheduleReconnect() {
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    connect();
  }, reconnectDelay);
}

function sendMessage(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function setConnectionState(state) {
  connectionState = state;
  // Broadcast al popup
  chrome.runtime.sendMessage({ type: 'connectionState', state }).catch(() => {
    // Popup non aperto, ignora
  });
}

// --- Command dispatcher ---

async function executeCommand(msg) {
  const { type, params = {} } = msg;

  switch (type) {
    case 'get_tabs':
      return await cmdGetTabs();
    case 'navigate':
      return await cmdNavigate(params);
    case 'screenshot':
      return await cmdScreenshot(params);
    case 'execute_js':
      return await cmdExecuteJs(params);
    case 'click':
      return await cmdClick(params);
    case 'type_text':
      return await cmdTypeText(params);
    case 'read_page':
      return await cmdReadPage(params);
    default:
      throw new Error(`Unknown command type: ${type}`);
  }
}

// --- Utility: risolvi tab_id ---

async function resolveTabId(tab_id) {
  if (tab_id) return tab_id;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab.id;
}

// --- Implementazione comandi ---

async function cmdGetTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    id: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    windowId: t.windowId,
  }));
}

async function cmdNavigate({ url, tab_id }) {
  if (!url) throw new Error('Missing required parameter: url');
  const tabId = await resolveTabId(tab_id);
  const tab = await chrome.tabs.update(tabId, { url });

  // Attendi che il caricamento sia completo
  await new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Timeout di sicurezza
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });

  const updatedTab = await chrome.tabs.get(tabId);
  return { url: updatedTab.url, title: updatedTab.title, tabId };
}

async function cmdScreenshot({ tab_id }) {
  const tabId = await resolveTabId(tab_id);

  // Assicurati che il tab sia attivo per fare lo screenshot
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });

  // Piccolo delay per dare tempo al rendering
  await new Promise((r) => setTimeout(r, 200));

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: 'png',
  });

  // Rimuovi il prefisso data:image/png;base64,
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  return { image: base64 };
}

async function cmdExecuteJs({ code, tab_id }) {
  if (!code) throw new Error('Missing required parameter: code');
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: new Function(code),
    world: 'MAIN',
  });

  return { result: results?.[0]?.result ?? null };
}

async function cmdClick({ selector, tab_id }) {
  if (!selector) throw new Error('Missing required parameter: selector');
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);
      el.click();
      return { tagName: el.tagName, text: el.textContent?.substring(0, 100) };
    },
    args: [selector],
    world: 'MAIN',
  });

  return results?.[0]?.result ?? { clicked: true };
}

async function cmdTypeText({ selector, text, tab_id }) {
  if (!selector) throw new Error('Missing required parameter: selector');
  if (text === undefined) throw new Error('Missing required parameter: text');
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, txt) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);
      el.focus();
      el.value = txt;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { typed: true };
    },
    args: [selector, text],
    world: 'MAIN',
  });

  return results?.[0]?.result ?? { typed: true };
}

async function cmdReadPage({ mode = 'text', tab_id }) {
  const tabId = await resolveTabId(tab_id);

  if (mode === 'html') {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML,
      world: 'MAIN',
    });
    return results?.[0]?.result ?? '';
  }

  if (mode === 'accessibility') {
    // Ritorna una struttura semplificata dell'a11y tree
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        function walk(el, depth = 0) {
          if (depth > 10) return '';
          const role = el.getAttribute('role') || el.tagName.toLowerCase();
          const label = el.getAttribute('aria-label') || el.textContent?.substring(0, 50)?.trim() || '';
          let output = `${'  '.repeat(depth)}[${role}] ${label}\n`;
          for (const child of el.children) {
            output += walk(child, depth + 1);
          }
          return output;
        }
        return walk(document.body);
      },
      world: 'MAIN',
    });
    return results?.[0]?.result ?? '';
  }

  // mode === 'text' (default)
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.body.innerText,
    world: 'MAIN',
  });
  return results?.[0]?.result ?? '';
}

// --- Avvia la connessione ---
connect();
```

**Commit:**
```bash
git add extension/service-worker.js && git commit -m "feat: add Chrome extension service worker with command dispatcher"
```

---

### Task 8: Extension — popup (html/js/css)

**Files:**
- Create: `~/.claude/chrome-bridge/extension/popup.html`
- Create: `~/.claude/chrome-bridge/extension/popup.js`
- Create: `~/.claude/chrome-bridge/extension/popup.css`

**popup.html:**
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div class="container">
    <h1>Chrome Bridge</h1>
    <div class="status">
      <div id="indicator" class="indicator disconnected"></div>
      <span id="status-text">Disconnected</span>
    </div>
    <p class="info">WebSocket: ws://localhost:8765</p>
  </div>
  <script src="popup.js"></script>
</body>
</html>
```

**popup.css:**
```css
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  width: 240px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  color: #333;
}

.container {
  padding: 16px;
}

h1 {
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 12px;
  color: #1a1a1a;
}

.status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.indicator {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
}

.indicator.connected    { background: #27ae60; }
.indicator.connecting   { background: #f39c12; }
.indicator.disconnected { background: #e74c3c; }

#status-text {
  font-weight: 600;
}

.info {
  font-size: 11px;
  color: #888;
  font-family: monospace;
}
```

**popup.js:**
```javascript
const indicator = document.getElementById('indicator');
const statusText = document.getElementById('status-text');

const labels = {
  connected: 'Connected',
  connecting: 'Connecting...',
  disconnected: 'Disconnected',
};

function updateUI(state) {
  indicator.className = `indicator ${state}`;
  statusText.textContent = labels[state] || state;
}

// Ascolta aggiornamenti dal service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'connectionState') {
    updateUI(msg.state);
  }
});

// Richiedi stato attuale al service worker
chrome.runtime.sendMessage({ type: 'getConnectionState' }, (response) => {
  if (response && response.state) {
    updateUI(response.state);
  }
});
```

**Nota:** Aggiungere nel service-worker.js il listener per `getConnectionState`:
```javascript
// Alla fine del service-worker.js, prima di connect():
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getConnectionState') {
    sendResponse({ state: connectionState });
  }
});
```

**Commit:**
```bash
git add extension/popup.html extension/popup.js extension/popup.css && git commit -m "feat: add extension popup with connection status indicator"
```

---

### Task 9: Extension — icone placeholder

**Files:**
- Create: `~/.claude/chrome-bridge/extension/icons/icon-16.png`
- Create: `~/.claude/chrome-bridge/extension/icons/icon-48.png`
- Create: `~/.claude/chrome-bridge/extension/icons/icon-128.png`

Generare icone SVG-to-PNG minimaliste. Approccio pragmatico: creare un piccolo script Node.js che genera PNG base usando un canvas minimale, oppure usare `convert` (ImageMagick) se disponibile.

**Alternativa se ImageMagick non è disponibile:** usare file PNG da 1 pixel colorato come placeholder, poi sostituire con icone vere.

```bash
# Opzione A: con ImageMagick (se disponibile)
convert -size 16x16 xc:'#4A90D9' extension/icons/icon-16.png
convert -size 48x48 xc:'#4A90D9' extension/icons/icon-48.png
convert -size 128x128 xc:'#4A90D9' extension/icons/icon-128.png

# Opzione B: script Node.js (da creare se ImageMagick non disponibile)
# Vedi implementazione nel task
```

**Commit:**
```bash
git add extension/icons/ && git commit -m "chore: add placeholder extension icons"
```

---

### Task 10: Registrazione MCP e test end-to-end

**Step 1: Registrare il server MCP in Claude Code**
```bash
claude mcp add chrome-bridge -- node ~/.claude/chrome-bridge/server/index.js
```

**Step 2: Caricare l'estensione in Chrome**
1. Aprire `chrome://extensions/` in Chrome su ChromeOS
2. Attivare "Developer mode" (toggle in alto a destra)
3. Click "Load unpacked"
4. Navigare a: `Linux files > .claude > chrome-bridge > extension` (nota: la home di Crostini appare come "Linux files" nel file picker di ChromeOS)
5. L'estensione apparirà nella lista con l'icona placeholder

**Step 3: Verificare la connessione**
1. Avviare una nuova sessione Claude Code (per caricare il nuovo MCP server)
2. Verificare che l'icona dell'estensione diventi verde (connected)
3. Testare:
   - `get_status` → `{"connected": true}`
   - `get_tabs` → lista dei tab aperti
   - `navigate` con `url: "https://www.google.com"` → pagina caricata
   - `screenshot` → immagine visibile
   - `execute_js` con `code: "document.title"` → titolo della pagina
   - `read_page` → testo della pagina
   - `click` con un selettore valido
   - `type_text` in un campo di input

---

## Sicurezza

- WebSocket bind solo su `127.0.0.1` (nessun accesso dalla rete)
- Nessuna autenticazione necessaria (comunicazione localhost tra processi fidati)
- Connessione singola (una nuova connessione sostituisce la precedente)
- Timeout su ogni comando per evitare blocchi
- `executeScript` con `world: 'MAIN'` per accesso al contesto della pagina

## Troubleshooting

| Problema | Soluzione |
|----------|-----------|
| Estensione non si connette | Verificare che il server MCP sia in esecuzione (`ps aux \| grep chrome-bridge`). Verificare che la porta 8765 sia accessibile da ChromeOS. |
| Screenshot fallisce | Il tab deve essere visibile e attivo. Verificare che non ci siano dialog/alert bloccanti. |
| `executeScript` fallisce | Alcune pagine (chrome://, about:) non permettono l'injection di script. Usare solo su pagine web normali. |
| Service worker si ferma | Il `chrome.alarms` keep-alive dovrebbe impedirlo. Se persiste, ricaricare l'estensione. |
| Porta già in uso | Cambiare la porta con `CHROME_BRIDGE_PORT=9999` nel comando MCP. |
