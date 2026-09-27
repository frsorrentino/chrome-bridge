/**
 * Esiti dei comandi che prima si fidavano di un valore di ripiego.
 *
 * Due casi osservati nel test Windows del 27/09/2026, validi su ogni OS:
 * - `click #checkout-button` con `query_dom` a count 0 rispondeva
 *   `{"clicked":true}` (type_text, hover e press_key allo stesso modo): la
 *   funzione iniettata lancia «Element not found», `executeScript` risolve
 *   con `result` undefined e il ripiego `?? { clicked: true }` lo
 *   trasformava in un successo.
 * - `navigate` verso una porta chiusa rispondeva `{url, title}` senza errore:
 *   la scheda mostra la pagina d'errore di Chrome, che arriva comunque a
 *   status 'complete'. L'errore vero passa solo da webNavigation.onErrorOccurred.
 */

/**
 * Risultato di click, type_text, hover e press_key: senza un risultato della
 * funzione iniettata il comando non è avvenuto, qualunque sia il motivo. Tutte
 * e quattro rispondevano con un successo di ripiego ({clicked|typed|hovered|
 * pressed: true}) su un selettore che non trova niente.
 */
export function elementOutcome(results, selector) {
  const first = results?.[0];
  if (first?.result != null) return first.result;
  if (first?.error?.message) throw new Error(first.error.message);
  if (!selector) throw new Error('The page returned no result for the command');
  throw new Error(`Element not found: ${selector} (no element matches; check it with query_dom)`);
}

/**
 * net::ERR_ABORTED non è un fallimento da riferire: è un download, una
 * risposta 204 o una navigazione sostituita da un'altra.
 */
export function isReportableNavError(details) {
  return details?.frameId === 0 && !!details.error && details.error !== 'net::ERR_ABORTED';
}

/**
 * Raccoglie gli errori di rete del frame principale, per scheda, dal momento
 * della chiamata. Va aperta PRIMA di tabs.create/tabs.update: un rifiuto di
 * connessione in locale arriva in pochi millisecondi, prima che l'id della
 * scheda nuova sia noto.
 */
export function watchNavErrors(onErrorOccurred) {
  const byTab = new Map();
  const listener = (details) => {
    if (isReportableNavError(details)) byTab.set(details.tabId, details);
  };
  onErrorOccurred.addListener(listener);
  return {
    errorFor: (tabId) => byTab.get(tabId) ?? null,
    stop: () => onErrorOccurred.removeListener(listener),
  };
}

export function navErrorMessage(details, tabId) {
  return `${details.error} loading ${details.url} (tab ${tabId} shows the browser's error page)`;
}
