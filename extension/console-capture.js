/**
 * Iniettato a document_start in MAIN world: cattura console.* fin dal
 * primo istante di vita della pagina, più errori non gestiti.
 */
(() => {
  if (window.__chromeBridge_consoleHooked) return;
  window.__chromeBridge_consoleHooked = true;
  window.__chromeBridge_consoleLogs = [];
  const MAX = 1000;
  const push = (entry) => {
    if (window.__chromeBridge_consoleLogs.length < MAX) window.__chromeBridge_consoleLogs.push(entry);
  };
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
    const orig = console[method].bind(console);
    console[method] = (...args) => {
      push({
        level: method,
        args: args.map((a) => {
          try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
          catch { return String(a); }
        }),
        timestamp: Date.now(),
      });
      orig(...args);
    };
  }
  window.addEventListener('error', (e) => {
    push({ level: 'error', args: [`Uncaught ${e.message} at ${e.filename || '?'}:${e.lineno || 0}`], timestamp: Date.now() });
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    let reason;
    try { reason = String(e.reason); } catch { reason = '<unstringifiable>'; }
    push({ level: 'error', args: [`Unhandled rejection: ${reason}`], timestamp: Date.now() });
  });
})();
