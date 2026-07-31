/**
 * Legge lo stato reale di un download.
 *
 * `chrome.downloads.download()` restituisce un id e basta: dire "started: true"
 * e fermarsi lì è come fidarsi di un HTTP 200 senza guardare il corpo. Su
 * ChromeOS, con l'impostazione «Chiedi dove salvare ogni file» attiva, Chrome
 * ignora `saveAs: false` e apre il selettore: il file viene scaricato per intero
 * ma non viene scritto da nessuna parte finché un umano non sceglie.
 *
 * La firma di quella condizione è precisa e verificata dal vivo:
 * `state: 'in_progress'`, `filename: ''`, `bytesReceived === totalBytes`.
 * Senza distinguerla, un agente aspetta un file che non arriverà mai da solo.
 */
export function classifyDownload(item) {
  if (!item) return { state: 'unknown', done: false, reason: 'download not found' };

  const { state, filename, bytesReceived = 0, totalBytes = 0, error } = item;

  if (state === 'complete') return { state: 'complete', done: true, filename };
  if (state === 'interrupted') {
    return { state: 'interrupted', done: true, error: error || 'interrupted', filename };
  }

  // Nessuna destinazione decisa: il selettore è aperto e aspetta una persona.
  if (!filename) {
    const fetched = totalBytes > 0 && bytesReceived >= totalBytes;
    return {
      state: 'waiting_for_user',
      done: false,
      bytes: { received: bytesReceived, total: totalBytes },
      reason: fetched
        ? 'bytes fetched, but Chrome is asking where to save — the "Ask where to save each file" setting overrides saveAs:false'
        : 'no destination chosen yet — Chrome is showing the save dialog',
    };
  }

  return {
    state: 'in_progress',
    done: false,
    filename,
    bytes: { received: bytesReceived, total: totalBytes },
  };
}
