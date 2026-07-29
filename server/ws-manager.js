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
import { DEFAULT_PORT, PING_INTERVAL_MS, IDENT_TIMEOUT_MS, PENDING_RELAY_TTL_MS, getTimeout, createCommand, MessageType, VERSION } from './protocol.js';

export class WSManager {
  constructor(port = DEFAULT_PORT, opts = {}) {
    this.port = port;
    // Default loopback: il bind su 0.0.0.0 esponeva il bridge a tutta la rete
    // con l'unico gate di un header Origin falsificabile e token null di
    // default — chiunque poteva prendere lo slot estensione e ottenere
    // execute_js nella sessione autenticata del browser. Su Crostini il
    // port-forward richiede 0.0.0.0: opt-in esplicito, non default.
    this.host = opts.host ?? process.env.CHROME_BRIDGE_HOST ?? '127.0.0.1';
    this.identTimeout = opts.identTimeout ?? IDENT_TIMEOUT_MS;
    this.token = opts.token ?? process.env.CHROME_BRIDGE_TOKEN ?? null;
    this.pingIntervalMs = opts.pingInterval ?? PING_INTERVAL_MS;
    this.pongGraceMs = opts.pongGrace ?? 10000;
    this.lastPong = 0;
    this.stopped = false;
    this.mode = null;            // 'primary' | 'relay'
    this.relayExtConnected = undefined;  // relay mode: stato estensione riportato dal primary
    this.relayExtVersion = null;
    this._extVersion = null;     // versione estensione da ext_init (primary)

    // --- primary mode ---
    this.wss = null;
    this.client = null;          // Connessione Chrome extension
    this.relayClients = new Set();
    this.pendingRelay = new Map(); // command id → { ws: relay WebSocket, ts: timestamp }
    this.pingTimer = null;

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
      // Il socket relay aperto non implica un'estensione collegata: get_status
      // rispondeva connected:true senza estensione da nessuna parte.
      return this.relaySocket !== null
        && this.relaySocket.readyState === WebSocket.OPEN
        && this.relayExtConnected !== false;
    }
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  /** Versione dell'estensione collegata (da ext_init), o null. */
  get extVersion() {
    return this.mode === 'relay' ? (this.relayExtVersion ?? null) : (this._extVersion ?? null);
  }

  /**
   * Invia un comando all'estensione Chrome e attende la risposta.
   * Funziona identicamente in primary e relay mode.
   */
  sendCommand(type, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        // Un errore vago qui costa un turno intero al modello: dice cosa
        // osservare e qual è la prossima azione.
        reject(new Error(
          `Chrome extension not connected (server ${this.mode} on ${this.host}:${this.port}`
          + `${this.mode === 'relay' ? ', reached through another chrome-bridge instance' : ''})`
          + ' — open Chrome, check the chrome-bridge extension is enabled and its port matches',
        ));
        return;
      }

      const command = createCommand(type, params);
      // Il timeout di trasporto non può essere più basso di quello chiesto dal
      // chiamante: `wait_for --timeout 90000` moriva a 60 s con un messaggio
      // che il modello leggeva come "l'elemento non è comparso".
      const asked = Number(params?.timeout);
      const timeout = Number.isFinite(asked) && asked > 0
        ? Math.max(getTimeout(type), asked + 5000)
        : getTimeout(type);

      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        reject(new Error(
          `Command ${type} timed out after ${timeout}ms`
          + (params?.tab_id != null ? ` (tab ${params.tab_id})` : '')
          + ' — the tab may be busy, crashed or showing a modal dialog: try tab_action reload, handle_dialogs, or raise the timeout',
        ));
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
    this.stopped = true;

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    this._rejectAllPending('Server shutting down');

    if (this.mode === 'relay') {
      if (this.relaySocket) {
        this.relaySocket.close(1000, 'MCP shutting down');
        this.relaySocket = null;
      }
      return;
    }

    // primary mode — terminate forzato per evitare hang sull'handshake.
    // Si itera wss.clients, non i due Set tracciati: un peer che completava
    // l'handshake DURANTE lo shutdown restava OPEN, wss.close() non richiamava
    // mai la callback e il processo MCP non usciva più (SIGKILL necessario).
    this.relayClients.clear();
    this.pendingRelay.clear();
    this.client = null;

    if (this.wss) {
      for (const ws of this.wss.clients) {
        try { ws.terminate(); } catch {}
      }
      return new Promise((resolve) => {
        // Rete di sicurezza: close() può non richiamare se un socket resta
        // appeso. Lo shutdown non deve dipendere dalla buona volontà di ws.
        const safety = setTimeout(resolve, 500);
        this.wss.close(() => { clearTimeout(safety); resolve(); });
      });
    }
  }

  // ─── Primary mode ──────────────────────────────────────────────

  _startPrimary() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({
        host: this.host,
        port: this.port,
        maxPayload: 32 * 1024 * 1024,
      });

      this.wss.on('listening', () => {
        // Porta 0 = effimera: leggi quella reale assegnata dal kernel
        if (!this.port) this.port = this.wss.address().port;
        console.error(`[chrome-bridge] WebSocket server listening on ${this.host}:${this.port}`);
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
   * - { type: 'ext_init', token? }  → estensione Chrome (Origin chrome-extension:// obbligatorio)
   * - { type: 'relay_init' }        → relay client (solo loopback)
   * Connessioni mute o non valide vengono terminate.
   */
  _handleNewConnection(ws, req) {
    // Durante lo shutdown non si accettano nuovi peer: era la via per cui un
    // handshake in corso rimetteva un socket OPEN dopo il terminate.
    if (this.stopped) { try { ws.terminate(); } catch {} return; }
    const origin = req.headers.origin || '';
    const remote = req.socket.remoteAddress || '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    const idTimer = setTimeout(() => {
      console.error(`[chrome-bridge] Unidentified connection from ${remote} — terminating`);
      ws.terminate();
    }, this.identTimeout);

    const onFirstMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.error('[chrome-bridge] Invalid JSON during handshake — terminating');
        clearTimeout(idTimer);
        ws.terminate();
        return;
      }

      clearTimeout(idTimer);
      ws.removeListener('message', onFirstMessage);

      if (msg.type === MessageType.RELAY_INIT) {
        if (!isLoopback) {
          console.error(`[chrome-bridge] relay_init from non-loopback ${remote} — rejected`);
          ws.terminate();
          return;
        }
        // Il token proteggeva solo ext_init: un relay locale non autenticato
        // aggirava interamente il segreto condiviso.
        if (this.token && msg.token !== this.token) {
          console.error('[chrome-bridge] relay_init with invalid token — rejected');
          ws.terminate();
          return;
        }
        this._setupRelayClient(ws);
        return;
      }

      if (msg.type === MessageType.EXT_INIT) {
        // L'estensione pubblicata si collega solo a ws://localhost: una
        // ext_init non-loopback è per definizione un client artigianale.
        if (!isLoopback && this.host === '127.0.0.1') {
          console.error(`[chrome-bridge] ext_init from non-loopback ${remote} — rejected`);
          ws.terminate();
          return;
        }
        if (!origin.startsWith('chrome-extension://')) {
          console.error(`[chrome-bridge] ext_init with origin "${origin}" — rejected`);
          ws.terminate();
          return;
        }
        if (this.token && msg.token !== this.token) {
          console.error('[chrome-bridge] ext_init with invalid token — rejected');
          ws.terminate();
          return;
        }
        this._setupChromeClient(ws, msg.version ?? null);
        return;
      }

      console.error(`[chrome-bridge] Unexpected first message type "${msg.type}" — rejected`);
      ws.terminate();
    };

    ws.on('message', onFirstMessage);
    ws.on('close', () => clearTimeout(idTimer));
  }

  _setupChromeClient(ws, extVersion = null) {
    this._extVersion = extVersion;
    // Lo skew server/estensione era invisibile: con la latenza di review del
    // Chrome Web Store è la norma, non l'eccezione.
    if (extVersion && extVersion !== VERSION) {
      console.error(`[chrome-bridge] Version skew: server ${VERSION}, extension ${extVersion}`);
    }
    console.error(`[chrome-bridge] Chrome extension connected${extVersion ? ` (v${extVersion})` : ''}`);
    try { ws.send(JSON.stringify({ type: 'ext_init_ok', version: VERSION })); } catch {}

    if (this.client) {
      console.error('[chrome-bridge] Replacing existing Chrome connection');
      this._rejectAllPending('Replaced by new extension connection');
      // Notifica anche i relay in attesa: le risposte ai loro comandi non arriveranno mai
      for (const [id, entry] of this.pendingRelay) {
        if (entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send(JSON.stringify({
            id,
            type: MessageType.ERROR,
            error: 'Chrome extension reconnected',
          }));
        }
      }
      this.pendingRelay.clear();
      this.client.close(1000, 'Replaced by new connection');
    }

    this.client = ws;
    this.lastPong = Date.now();
    this._broadcastExtState();

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
        this._extVersion = null;
        this._broadcastExtState();
        // Rigetta pending locali
        this._rejectAllPending('Extension disconnected');
        // Notifica relay clients
        for (const [id, entry] of this.pendingRelay) {
          if (entry.ws.readyState === WebSocket.OPEN) {
            entry.ws.send(JSON.stringify({
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
    // Ack: senza questo, un relay puntato su un WS server ESTRANEO che occupa
    // la porta dichiarava mode=relay e isConnected()=true, e il primo comando
    // moriva 30 s dopo con un messaggio che non nominava la causa.
    this._sendRelayHello(ws);

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
      this.pendingRelay.set(msg.id, { ws, ts: Date.now() });
      this.client.send(JSON.stringify(msg));
    });

    ws.on('close', () => {
      console.error('[chrome-bridge] Relay client disconnected');
      this.relayClients.delete(ws);
      // Pulisci pending relay per questo client
      for (const [id, entry] of this.pendingRelay) {
        if (entry.ws === ws) {
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
      this.lastPong = Date.now();
      return;
    }

    // Risposta per un relay client?
    const entry = this.pendingRelay.get(msg.id);
    if (entry) {
      this.pendingRelay.delete(msg.id);
      if (entry.ws.readyState === WebSocket.OPEN) {
        entry.ws.send(JSON.stringify(msg));
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

  /** Ack di identificazione verso un relay client + stato corrente dell'estensione. */
  _sendRelayHello(ws) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({
        type: 'relay_init_ok',
        version: VERSION,
        ext_connected: this.client !== null && this.client.readyState === WebSocket.OPEN,
        ext_version: this._extVersion ?? null,
      }));
    } catch {}
  }

  /** Notifica a tutti i relay che lo stato dell'estensione è cambiato. */
  _broadcastExtState() {
    for (const ws of this.relayClients) this._sendRelayHello(ws);
  }

  _startRelay() {
    return new Promise((resolve, reject) => {
      this.relaySocket = new WebSocket(`ws://127.0.0.1:${this.port}`);
      // Attende l'ack: una porta occupata da un processo che non è
      // chrome-bridge deve fallire subito e con un messaggio azionabile,
      // non costare un timeout di 30 s al primo comando.
      //
      // Il silenzio però è ambiguo: un primary chrome-bridge PRECEDENTE a questa
      // versione non conosce relay_init_ok, e durante un aggiornamento è il caso
      // normale (una sessione vecchia è ancora attiva). Prima di fallire si
      // sonda il peer con un comando reale: un chrome-bridge risponde sempre —
      // col risultato o con un errore "extension not connected" — mentre un
      // server estraneo resta muto.
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(ackTimer);
        clearTimeout(this._probeTimer);
        this._relayAck = null;
        this._probeId = null;
        if (!err) return resolve();
        const sock = this.relaySocket;
        this.relaySocket = null;
        try { sock?.terminate(); } catch {}
        reject(err);
      };

      const probe = () => {
        const cmd = createCommand(MessageType.GET_TABS);
        this._probeId = cmd.id;
        try {
          this.relaySocket.send(JSON.stringify(cmd));
        } catch {
          finish(new Error(`Port ${this.port} is held by a process that is not chrome-bridge — set CHROME_BRIDGE_PORT to a free port or stop that process`));
          return;
        }
        this._probeTimer = setTimeout(() => {
          finish(new Error(`Port ${this.port} is held by a process that is not chrome-bridge (no relay_init_ok and no answer to a probe command) — set CHROME_BRIDGE_PORT to a free port or stop that process`));
        }, 1500);
      };

      const ackTimer = setTimeout(probe, 2000);
      this._relayAck = () => finish(null);
      this._probeAnswered = () => {
        console.error('[chrome-bridge] Relay peer answered a probe but not relay_init_ok: older chrome-bridge, proceeding');
        finish(null);
      };

      this.relaySocket.on('open', () => {
        // Identifica questa connessione come relay
        const init = { type: MessageType.RELAY_INIT };
        if (this.token) init.token = this.token;
        this.relaySocket.send(JSON.stringify(init));
        console.error(`[chrome-bridge] Connected as relay to existing server on port ${this.port}`);
      });

      this.relaySocket.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (msg.type === 'relay_init_ok') {
          this.primaryVersion = msg.version ?? null;
          this.relayExtConnected = msg.ext_connected === true;
          this.relayExtVersion = msg.ext_version ?? null;
          if (this._relayAck) this._relayAck();
          return;
        }

        // Risposta alla sonda: il peer parla il protocollo, è un chrome-bridge
        // più vecchio. relayExtConnected resta undefined (sconosciuto), che
        // isConnected() tratta come "non bloccare".
        if (this._probeId && msg.id === this._probeId) {
          if (this._probeAnswered) this._probeAnswered();
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
    if (this.stopped) return;

    const MAX_ATTEMPTS = 5;
    const BASE_DELAY_MS = 500;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const delay = BASE_DELAY_MS * attempt;
      await new Promise(r => setTimeout(r, delay));
      if (this.stopped) return;

      console.error(`[chrome-bridge] Promotion attempt ${attempt}/${MAX_ATTEMPTS}...`);

      try {
        await this._startPrimary();
        // stop() chiamato mentre la promozione era in volo: smonta ciò che è appena stato creato
        if (this.stopped) {
          if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
          }
          if (this.wss) {
            this.wss.close();
            this.wss = null;
          }
          return;
        }
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
    this.pingTimer = setInterval(() => {
      if (this.client && this.client.readyState === WebSocket.OPEN) {
        // Half-open detection: nessun pong da troppo tempo → terminate
        // (lastPong è sempre inizializzato in _setupChromeClient)
        if (Date.now() - this.lastPong > this.pingIntervalMs * 2 + this.pongGraceMs) {
          console.error('[chrome-bridge] Extension unresponsive (no pong) — terminating connection');
          this.client.terminate();
          return;
        }
        this.client.send(JSON.stringify({
          type: MessageType.PING,
          timestamp: Date.now(),
        }));
      }
      // Sweep pendingRelay scaduti
      const cutoff = Date.now() - PENDING_RELAY_TTL_MS;
      for (const [id, entry] of this.pendingRelay) {
        if (entry.ts < cutoff) this.pendingRelay.delete(id);
      }
    }, this.pingIntervalMs);
  }

  _rejectAllPending(reason) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
