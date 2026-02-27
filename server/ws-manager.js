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
