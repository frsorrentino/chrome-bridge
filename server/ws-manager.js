/**
 * Gestisce la connessione con l'estensione Chrome via WebSocket.
 *
 * Supporta due modalità:
 * - PRIMARY: avvia un WebSocket server sulla porta configurata.
 *   Accetta la connessione dell'estensione Chrome e, opzionalmente,
 *   connessioni relay da altre istanze MCP.
 * - RELAY: se la porta è già occupata (altra istanza primary attiva),
 *   si connette come client al server esistente e inoltra i comandi.
 *
 * Dall'esterno (tools.js) l'interfaccia è identica in entrambe le modalità:
 * - isConnected() → boolean
 * - sendCommand(type, params) → Promise<data>
 */

import WebSocket, { WebSocketServer } from 'ws';
import { DEFAULT_PORT, PING_INTERVAL_MS, IDENT_TIMEOUT_MS, getTimeout, createCommand, MessageType } from './protocol.js';

export class WSManager {
  constructor(port = DEFAULT_PORT, opts = {}) {
    this.port = port;
    this.identTimeout = opts.identTimeout ?? IDENT_TIMEOUT_MS;
    this.token = opts.token ?? process.env.CHROME_BRIDGE_TOKEN ?? null;
    this.mode = null;            // 'primary' | 'relay'

    // --- primary mode ---
    this.wss = null;
    this.client = null;          // Connessione Chrome extension
    this.relayClients = new Set();
    this.pendingRelay = new Map(); // command id → relay WebSocket
    this.pingInterval = null;

    // --- relay mode ---
    this.relaySocket = null;

    // --- shared ---
    this.pending = new Map();    // id → { resolve, reject, timer }
  }

  // ─── Public API ────────────────────────────────────────────────

  /**
   * Avvia il manager: tenta primary, fallback relay.
   */
  async start() {
    try {
      await this._startPrimary();
      this.mode = 'primary';
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        console.error(`[chrome-bridge] Port ${this.port} in use — connecting as relay`);
        await this._startRelay();
        this.mode = 'relay';
      } else {
        throw err;
      }
    }
  }

  /**
   * Verifica se è possibile inviare comandi.
   */
  isConnected() {
    if (this.mode === 'relay') {
      return this.relaySocket !== null && this.relaySocket.readyState === WebSocket.OPEN;
    }
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  /**
   * Invia un comando all'estensione Chrome e attende la risposta.
   * Funziona identicamente in primary e relay mode.
   */
  sendCommand(type, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        const target = this.mode === 'relay' ? 'Relay connection' : 'Chrome extension';
        reject(new Error(`${target} not connected`));
        return;
      }

      const command = createCommand(type, params);
      const timeout = getTimeout(type);

      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        reject(new Error(`Command ${type} timed out after ${timeout}ms`));
      }, timeout);

      this.pending.set(command.id, { resolve, reject, timer });

      const socket = this.mode === 'relay' ? this.relaySocket : this.client;
      socket.send(JSON.stringify(command));
    });
  }

  /**
   * Chiude tutto.
   */
  async stop() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    this._rejectAllPending('Server shutting down');

    if (this.mode === 'relay') {
      if (this.relaySocket) {
        this.relaySocket.close(1000, 'MCP shutting down');
        this.relaySocket = null;
      }
      return;
    }

    // primary mode — terminate forzato per evitare hang sull'handshake
    for (const relay of this.relayClients) {
      relay.terminate();
    }
    this.relayClients.clear();
    this.pendingRelay.clear();

    if (this.client) {
      this.client.terminate();
      this.client = null;
    }

    if (this.wss) {
      return new Promise((resolve) => {
        this.wss.close(() => resolve());
      });
    }
  }

  // ─── Primary mode ──────────────────────────────────────────────

  _startPrimary() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({
        host: '0.0.0.0',
        port: this.port,
      });

      this.wss.on('listening', () => {
        console.error(`[chrome-bridge] WebSocket server listening on 0.0.0.0:${this.port}`);
        this._startPing();
        resolve();
      });

      this.wss.on('error', (err) => {
        console.error(`[chrome-bridge] WebSocket server error:`, err.message);
        reject(err);
      });

      this.wss.on('connection', (ws, req) => {
        this._handleNewConnection(ws, req);
      });
    });
  }

  /**
   * Ogni connessione DEVE identificarsi col primo messaggio:
   * - { type: 'ext_init', token? }  → estensione Chrome (Origin chrome-extension://)
   * - { type: 'relay_init' }        → relay client (solo loopback)
   * Connessioni mute o non valide vengono terminate.
   */
  _handleNewConnection(ws, req) {
    const origin = req.headers.origin || '';
    const remote = req.socket.remoteAddress || '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    let identified = false;

    const idTimer = setTimeout(() => {
      if (!identified) {
        console.error(`[chrome-bridge] Unidentified connection from ${remote} — terminating`);
        ws.terminate();
      }
    }, this.identTimeout);

    const onFirstMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        clearTimeout(idTimer);
        ws.terminate();
        return;
      }

      identified = true;
      clearTimeout(idTimer);
      ws.removeListener('message', onFirstMessage);

      if (msg.type === MessageType.RELAY_INIT) {
        if (!isLoopback) {
          console.error(`[chrome-bridge] relay_init from non-loopback ${remote} — rejected`);
          ws.terminate();
          return;
        }
        this._setupRelayClient(ws);
        return;
      }

      if (msg.type === MessageType.EXT_INIT) {
        if (origin && !origin.startsWith('chrome-extension://')) {
          console.error(`[chrome-bridge] ext_init with origin ${origin} — rejected`);
          ws.terminate();
          return;
        }
        if (this.token && msg.token !== this.token) {
          console.error('[chrome-bridge] ext_init with invalid token — rejected');
          ws.terminate();
          return;
        }
        this._setupChromeClient(ws);
        return;
      }

      console.error(`[chrome-bridge] Unexpected first message type "${msg.type}" — rejected`);
      ws.terminate();
    };

    ws.on('message', onFirstMessage);
    ws.on('close', () => clearTimeout(idTimer));
  }

  _setupChromeClient(ws) {
    console.error('[chrome-bridge] Chrome extension connected');

    if (this.client) {
      console.error('[chrome-bridge] Replacing existing Chrome connection');
      this.client.close(1000, 'Replaced by new connection');
    }

    this.client = ws;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.error('[chrome-bridge] Invalid JSON received');
        return;
      }
      this._handleChromeMessage(msg);
    });

    ws.on('close', () => {
      console.error('[chrome-bridge] Chrome extension disconnected');
      if (this.client === ws) {
        this.client = null;
        // Rigetta pending locali
        this._rejectAllPending('Extension disconnected');
        // Notifica relay clients
        for (const [id, relaySock] of this.pendingRelay) {
          if (relaySock.readyState === WebSocket.OPEN) {
            relaySock.send(JSON.stringify({
              id,
              type: MessageType.ERROR,
              error: 'Chrome extension disconnected',
            }));
          }
        }
        this.pendingRelay.clear();
      }
    });

    ws.on('error', (err) => {
      console.error('[chrome-bridge] Chrome client error:', err.message);
    });
  }

  _setupRelayClient(ws) {
    console.error('[chrome-bridge] Relay client connected');
    this.relayClients.add(ws);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.error('[chrome-bridge] Invalid JSON from relay client');
        return;
      }

      // Il relay client invia comandi da inoltrare a Chrome
      if (!this.client || this.client.readyState !== WebSocket.OPEN) {
        ws.send(JSON.stringify({
          id: msg.id,
          type: MessageType.ERROR,
          error: 'Chrome extension not connected',
        }));
        return;
      }

      // Traccia quale relay ha inviato questo comando
      this.pendingRelay.set(msg.id, ws);
      this.client.send(JSON.stringify(msg));
    });

    ws.on('close', () => {
      console.error('[chrome-bridge] Relay client disconnected');
      this.relayClients.delete(ws);
      // Pulisci pending relay per questo client
      for (const [id, sock] of this.pendingRelay) {
        if (sock === ws) {
          this.pendingRelay.delete(id);
        }
      }
    });

    ws.on('error', (err) => {
      console.error('[chrome-bridge] Relay client error:', err.message);
    });
  }

  /**
   * Gestisce un messaggio dall'estensione Chrome.
   * Smista le risposte: ai pending locali o ai relay client.
   */
  _handleChromeMessage(msg) {
    if (msg.type === MessageType.PONG) {
      return;
    }

    // Risposta per un relay client?
    const relaySock = this.pendingRelay.get(msg.id);
    if (relaySock) {
      this.pendingRelay.delete(msg.id);
      if (relaySock.readyState === WebSocket.OPEN) {
        relaySock.send(JSON.stringify(msg));
      }
      return;
    }

    // Risposta per un comando locale
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

  // ─── Relay mode ────────────────────────────────────────────────

  _startRelay() {
    return new Promise((resolve, reject) => {
      this.relaySocket = new WebSocket(`ws://127.0.0.1:${this.port}`);

      this.relaySocket.on('open', () => {
        // Identifica questa connessione come relay
        this.relaySocket.send(JSON.stringify({ type: MessageType.RELAY_INIT }));
        console.error(`[chrome-bridge] Connected as relay to existing server on port ${this.port}`);
        resolve();
      });

      this.relaySocket.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        const pending = this.pending.get(msg.id);
        if (!pending) return;

        this.pending.delete(msg.id);
        clearTimeout(pending.timer);

        if (msg.type === MessageType.ERROR) {
          pending.reject(new Error(msg.error || 'Unknown error'));
        } else {
          pending.resolve(msg.data);
        }
      });

      this.relaySocket.on('close', () => {
        console.error('[chrome-bridge] Relay connection closed');
        this.relaySocket = null;
        this._rejectAllPending('Relay connection closed');
        this._promoteToPrimary();
      });

      this.relaySocket.on('error', (err) => {
        console.error('[chrome-bridge] Relay connection error:', err.message);
        reject(err);
      });
    });
  }

  /**
   * Promozione: quando il primary muore, il relay tenta di diventare primary.
   * Attende un breve intervallo per dare tempo al vecchio WSS di chiudersi,
   * poi ritenta con backoff se la porta non è ancora libera.
   */
  async _promoteToPrimary() {
    const MAX_ATTEMPTS = 5;
    const BASE_DELAY_MS = 500;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const delay = BASE_DELAY_MS * attempt;
      await new Promise(r => setTimeout(r, delay));

      console.error(`[chrome-bridge] Promotion attempt ${attempt}/${MAX_ATTEMPTS}...`);

      try {
        await this._startPrimary();
        this.mode = 'primary';
        console.error('[chrome-bridge] Promoted to primary successfully');
        return;
      } catch (err) {
        if (err.code === 'EADDRINUSE') {
          // Porta occupata: un altro relay ha vinto, o il vecchio server non ha ancora chiuso
          console.error(`[chrome-bridge] Port still in use (attempt ${attempt})`);
          // All'ultimo tentativo, prova a riconnettersi come relay
          if (attempt === MAX_ATTEMPTS) {
            console.error('[chrome-bridge] Reconnecting as relay to new primary');
            try {
              await this._startRelay();
              this.mode = 'relay';
              return;
            } catch (relayErr) {
              console.error('[chrome-bridge] Failed to reconnect as relay:', relayErr.message);
            }
          }
        } else {
          console.error('[chrome-bridge] Promotion failed:', err.message);
          return;
        }
      }
    }
  }

  // ─── Shared helpers ────────────────────────────────────────────

  _startPing() {
    this.pingInterval = setInterval(() => {
      if (this.client && this.client.readyState === WebSocket.OPEN) {
        this.client.send(JSON.stringify({
          type: MessageType.PING,
          timestamp: Date.now(),
        }));
      }
    }, PING_INTERVAL_MS);
  }

  _rejectAllPending(reason) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
