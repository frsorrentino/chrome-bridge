/**
 * Gancio fetch/XHR in MAIN world, a document_start insieme alla cattura della
 * console (vedi _applyInstrumentation nel service worker): le richieste fatte
 * durante il caricamento della pagina entrano nel buffer letto da
 * monitor_network. Prima il gancio arrivava solo alla prima chiamata e la
 * richiesta fallita all'avvio, il caso tipico da debuggare, non si vedeva.
 * Lo stesso file viene iniettato da ensureNetworkHook sulle pagine aperte
 * prima dell'estensione; la guardia lo rende idempotente.
 */
(() => {
      if (window.__chromeBridge_networkHooked) return;
      window.__chromeBridge_networkHooked = true;
      window.__chromeBridge_networkRequests = [];
      window.__chromeBridge_netSeq = 0;
      window.__chromeBridge_inflight = 0;
      window.__chromeBridge_lastNetActivity = Date.now();
      const MAX = 1000;

      // --- Patch fetch ---
      const origFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const req = args[0];
        const url = typeof req === 'string' ? req : req?.url || String(req);
        const method = (args[1]?.method || (req?.method) || 'GET').toUpperCase();
        const entry = { type: 'fetch', method, url, startTime: Date.now(), status: null, duration: null, error: null };
        window.__chromeBridge_inflight += 1;
        window.__chromeBridge_lastNetActivity = Date.now();
        try {
          const resp = await origFetch(...args);
          entry.status = resp.status;
          entry.duration = Date.now() - entry.startTime;
          // Ring buffer: scarta le più VECCHIE, non le nuove. Scartare le nuove
          // faceva consegnare al modello le richieste dei primi secondi di vita
          // della pagina etichettate come "most recent".
          entry.seq = ++window.__chromeBridge_netSeq; window.__chromeBridge_networkRequests.push(entry);
          if (window.__chromeBridge_networkRequests.length > MAX) {
            window.__chromeBridge_networkRequests.shift();
          }
          window.__chromeBridge_inflight -= 1;
          window.__chromeBridge_lastNetActivity = Date.now();
          return resp;
        } catch (err) {
          entry.error = err.message;
          entry.duration = Date.now() - entry.startTime;
          // Ring buffer: scarta le più VECCHIE, non le nuove. Scartare le nuove
          // faceva consegnare al modello le richieste dei primi secondi di vita
          // della pagina etichettate come "most recent".
          entry.seq = ++window.__chromeBridge_netSeq; window.__chromeBridge_networkRequests.push(entry);
          if (window.__chromeBridge_networkRequests.length > MAX) {
            window.__chromeBridge_networkRequests.shift();
          }
          window.__chromeBridge_inflight -= 1;
          window.__chromeBridge_lastNetActivity = Date.now();
          throw err;
        }
      };

      // --- Patch XMLHttpRequest ---
      const OrigXHR = window.XMLHttpRequest;
      const origOpen = OrigXHR.prototype.open;
      const origSend = OrigXHR.prototype.send;
      OrigXHR.prototype.open = function (method, url, ...rest) {
        this.__cb_method = method;
        this.__cb_url = url;
        return origOpen.call(this, method, url, ...rest);
      };
      OrigXHR.prototype.send = function (...args) {
        const entry = { type: 'xhr', method: (this.__cb_method || 'GET').toUpperCase(), url: this.__cb_url || '', startTime: Date.now(), status: null, duration: null, error: null };
        this.addEventListener('load', () => {
          entry.status = this.status;
          entry.duration = Date.now() - entry.startTime;
          // Ring buffer: scarta le più VECCHIE, non le nuove. Scartare le nuove
          // faceva consegnare al modello le richieste dei primi secondi di vita
          // della pagina etichettate come "most recent".
          entry.seq = ++window.__chromeBridge_netSeq; window.__chromeBridge_networkRequests.push(entry);
          if (window.__chromeBridge_networkRequests.length > MAX) {
            window.__chromeBridge_networkRequests.shift();
          }
        });
        this.addEventListener('error', () => {
          entry.error = 'Network error';
          entry.duration = Date.now() - entry.startTime;
          // Ring buffer: scarta le più VECCHIE, non le nuove. Scartare le nuove
          // faceva consegnare al modello le richieste dei primi secondi di vita
          // della pagina etichettate come "most recent".
          entry.seq = ++window.__chromeBridge_netSeq; window.__chromeBridge_networkRequests.push(entry);
          if (window.__chromeBridge_networkRequests.length > MAX) {
            window.__chromeBridge_networkRequests.shift();
          }
        });
        // loadend copre load, error e abort: traccia sempre la fine dell'in-flight
        this.addEventListener('loadend', () => {
          window.__chromeBridge_inflight -= 1;
          window.__chromeBridge_lastNetActivity = Date.now();
        });
        window.__chromeBridge_inflight += 1;
        window.__chromeBridge_lastNetActivity = Date.now();
        return origSend.apply(this, args);
      };
    })();
