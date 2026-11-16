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
  throw notFoundError(selector);
}

/**
 * Sintassi di Playwright, jQuery o XPath dentro un selettore CSS: querySelector
 * la rifiuta con un SyntaxError, che executeScript riduce a un risultato vuoto.
 * «no element matches» faceva credere a un selettore valido senza riscontri
 * (note observe chrome-bridg-a1255c1b, chrome-bridg-5a9d399e, 1.32.1). Le
 * stringhe tra virgolette si tolgono prima: `[title=":visible"]` è CSS valido.
 */
export function nonCssToken(selector) {
  const s = String(selector).replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  if (/^\s*\(?\/\//.test(s) || /(^|[\s,])xpath=/.test(s)) return 'XPath';
  const engine = /(^|[\s,])(text|css|id|role|data-testid|internal:[\w-]+)=/.exec(s);
  if (engine) return `${engine[2]}=`;
  if (/(^|[^>])>>(?!>)/.test(s)) return '>>';
  const pseudo = /:(has-text|text-is|text-matches|text|visible|hidden|nth-match|left-of|right-of|above|below|near|contains|eq|gt|lt|first|last|even|odd)(?![\w-])/.exec(s);
  return pseudo ? `:${pseudo[1]}` : null;
}

export function notFoundError(selector) {
  const token = nonCssToken(selector);
  if (!token && String(selector).includes('>>>')) {
    // Dalla 1.32.4 ">>>" cerca la parte dopo sotto ogni elemento che la parte
    // prima trova, nel light DOM e in ogni shadow root aperto (lib/deep-query.js):
    // un antenato dell'host va bene («main >>> span», note observe
    // chrome-bridg-6379570f, chrome-bridg-f262acc4). Restano fuori i chiusi.
    const scope = String(selector).split('>>>')[0].trim();
    return new Error(`Element not found: ${selector} (no element matches; ">>>" looks for the part after it under every element "${scope}" matches, `
      + 'in the light DOM and in open shadow roots at any depth; closed shadow roots stay out of reach. '
      + 'Check it with query_dom, or locate the target by its visible text with find_text)');
  }
  if (!token) return new Error(`Element not found: ${selector} (no element matches; check it with query_dom)`);
  const what = token === 'XPath' ? 'XPath is not CSS' : `"${token}" is Playwright/jQuery syntax, not CSS`;
  return new Error(`Invalid selector: ${selector} — ${what}: the page rejects the whole selector, every item of a comma list included. `
    + 'Use plain CSS (">>>" pierces shadow DOM), a ref from get_interactives, or find_text to locate by visible text.');
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
