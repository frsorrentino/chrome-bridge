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
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
    const orig = console[method].bind(console);
    console[method] = (...args) => {
      try {
        push({
          level: method,
          args: args.map((a) => {
            try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
            catch { return String(a); }
          }),
          timestamp: Date.now(),
        });
      } catch {}
      return orig(...args);
    };
  }
  window.addEventListener('error', (e) => {
    try { push({ level: 'error', args: [`Uncaught ${e.message} at ${e.filename || '?'}:${e.lineno || 0}`], timestamp: Date.now() }); } catch {}
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    try {
      let reason;
      try { reason = String(e.reason); } catch { reason = '<unstringifiable>'; }
      push({ level: 'error', args: [`Unhandled rejection: ${reason}`], timestamp: Date.now() });
    } catch {}
  });
})();
