/**
 * Funzioni pure per la telemetria del popup: ring buffer degli errori
 * recenti e report diagnostico copiabile. Nessuna API chrome.* qui:
 * il file è importato sia dal service worker sia dai unit test Node
 * (side-effect import, export su globalThis).
 */
(() => {
  function pushError(buf, entry, max = 5) {
    const next = buf.concat([entry]);
    return next.length > max ? next.slice(next.length - max) : next;
  }

  function buildDiagnostics(d) {
    return JSON.stringify({
      extension: d.extensionVersion,
      server: d.serverVersion || 'unknown',
      chrome: d.chromeVersion,
      state: d.state,
      port: d.port,
      userScripts: d.userScriptsEnabled,
      instrument: d.instrument,
      toolCalls: d.toolCallCount,
      lastTool: d.lastTool,
      recentErrors: d.recentErrors,
    }, null, 2);
  }

  globalThis.__cbTelemetry = { pushError, buildDiagnostics };
})();
