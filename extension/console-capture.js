/**
 * Iniettato a document_start in MAIN world: cattura console.* fin dal
 * primo istante di vita della pagina, più errori non gestiti.
 *
 * Registrato dinamicamente dal service worker solo quando l'instrumentation
 * è attiva (toggle nel popup): pagine non in debug hanno zero footprint.
 * La cattura non deve mai lanciare nella pagina: ogni hook è in try/catch e
 * delega sempre all'originale.
 */
(() => {
  if (window.__chromeBridge_consoleHooked) return;
  window.__chromeBridge_consoleHooked = true;
  window.__chromeBridge_consoleLogs = [];
  const MAX = 1000;
  const push = (entry) => {
    const buf = window.__chromeBridge_consoleLogs;
    if (buf.length >= MAX) buf.shift(); // ring buffer: tieni i più recenti, non i primi 1000
    buf.push(entry);
  };
  // Un Error passato a console.error diventava "{}" (JSON.stringify non vede
  // message e stack, che non sono enumerabili): lo stack è l'unica cosa che
  // read_console(sourcemap) può riportare ai sorgenti. Duck typing e non
  // instanceof, perché un Error di un iframe viene da un altro realm.
  const errorText = (v) => (v && typeof v === 'object' && typeof v.message === 'string'
    ? (typeof v.stack === 'string' && v.stack ? v.stack : `${v.name || 'Error'}: ${v.message}`)
    : null);
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
    const orig = console[method].bind(console);
    console[method] = (...args) => {
      try {
        push({
          level: method,
          args: args.map((a) => {
            try { return errorText(a) ?? (typeof a === 'object' ? JSON.stringify(a) : String(a)); }
            catch { return String(a); }
          }),
          timestamp: Date.now(),
        });
      } catch {}
      return orig(...args);
    };
  }
  window.addEventListener('error', (e) => {
    try {
      // Un'immagine o uno script che non si carica arriva qui in fase di
      // cattura, con target l'elemento e nessun messaggio: prima diventava
      // «Uncaught  at ?:0:0». Ora dice quale risorsa.
      const t = e.target;
      if (t && t !== window && t.tagName) {
        const url = t.currentSrc || t.src || t.href || '';
        push({ level: 'error', args: [`Failed to load ${String(t.tagName).toLowerCase()}${url ? ` ${url}` : ''}`], timestamp: Date.now() });
        return;
      }
      // Con la colonna il frame diventa url:riga:colonna, risolvibile dalla source map.
      const stack = errorText(e.error);
      push({
        level: 'error',
        args: [stack ? `Uncaught ${stack}` : `Uncaught ${e.message} at ${e.filename || '?'}:${e.lineno || 0}:${e.colno || 0}`],
        timestamp: Date.now(),
      });
    } catch {}
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    try {
      let reason;
      try { reason = errorText(e.reason) ?? String(e.reason); } catch { reason = '<unstringifiable>'; }
      push({ level: 'error', args: [`Unhandled rejection: ${reason}`], timestamp: Date.now() });
    } catch {}
  });
})();
