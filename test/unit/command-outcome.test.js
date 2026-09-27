/**
 * Due successi falsi osservati nel test Windows del 27/09/2026 (su ogni OS):
 * `click` su un selettore senza corrispondenze rispondeva {"clicked":true}
 * (type_text, hover e press_key allo stesso modo), e
 * `navigate` verso una porta chiusa rispondeva {url, title} senza errore.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elementOutcome, isReportableNavError, watchNavErrors, navErrorMessage } from '../../extension/lib/command-outcome.js';

test('click senza risultato dalla funzione iniettata è un errore, non un successo', () => {
  // Quello che executeScript restituisce quando la funzione lancia «Element not found».
  assert.throws(() => elementOutcome([{ frameId: 0, documentId: 'd' }], '#checkout-button'), /Element not found: #checkout-button/);
  assert.throws(() => elementOutcome([{ frameId: 0, result: null }], '#x'), /Element not found: #x/);
  assert.throws(() => elementOutcome([], '#x'), /Element not found/);
  assert.throws(() => elementOutcome(undefined, '#x'), /Element not found/);
});

test('press_key senza selettore e senza risultato: errore generico, non «Element not found: undefined»', () => {
  assert.throws(() => elementOutcome([{ frameId: 0 }], null), /^Error: The page returned no result for the command$/);
});

test('click: il messaggio d\'errore del frame, se c\'è, passa com\'è', () => {
  assert.throws(() => elementOutcome([{ frameId: 0, error: { message: 'Element not found: #a >>> b' } }], '#a >>> b'), /^Error: Element not found: #a >>> b$/);
});

test('click: un esito vero, anche negativo, resta com\'è', () => {
  const hit = { clicked: true, button: 'left', count: 1, tagName: 'BUTTON' };
  assert.deepEqual(elementOutcome([{ frameId: 0, result: hit }], 'button'), hit);
  const occluded = { clicked: false, occluded: true, occluder: { selector: '#modal' } };
  assert.deepEqual(elementOutcome([{ frameId: 0, result: occluded }], 'button'), occluded);
});

test('errori di navigazione: solo il frame principale, ERR_ABORTED escluso', () => {
  assert.equal(isReportableNavError({ frameId: 0, error: 'net::ERR_CONNECTION_REFUSED' }), true);
  assert.equal(isReportableNavError({ frameId: 0, error: 'net::ERR_NAME_NOT_RESOLVED' }), true);
  assert.equal(isReportableNavError({ frameId: 3, error: 'net::ERR_CONNECTION_REFUSED' }), false, 'un iframe rotto non fa fallire la pagina');
  assert.equal(isReportableNavError({ frameId: 0, error: 'net::ERR_ABORTED' }), false, 'download, 204, navigazione sostituita');
  assert.equal(isReportableNavError(undefined), false);
});

function fakeEvent() {
  const listeners = new Set();
  return {
    addListener: (l) => listeners.add(l),
    removeListener: (l) => listeners.delete(l),
    fire: (d) => { for (const l of listeners) l(d); },
    get size() { return listeners.size; },
  };
}

test('watchNavErrors tiene l\'errore della scheda giusta anche se arriva prima che l\'id sia noto', () => {
  const ev = fakeEvent();
  const w = watchNavErrors(ev);
  // Il rifiuto in locale arriva prima che tabs.create risolva con l'id.
  ev.fire({ tabId: 41, frameId: 0, error: 'net::ERR_CONNECTION_REFUSED', url: 'http://127.0.0.1:9/' });
  ev.fire({ tabId: 99, frameId: 0, error: 'net::ERR_NAME_NOT_RESOLVED', url: 'http://altro.invalid/' });
  ev.fire({ tabId: 41, frameId: 2, error: 'net::ERR_BLOCKED_BY_CLIENT', url: 'http://ads.test/' });
  assert.equal(w.errorFor(41).error, 'net::ERR_CONNECTION_REFUSED');
  assert.equal(w.errorFor(7), null);
  w.stop();
  assert.equal(ev.size, 0, 'il listener non resta appeso dopo il comando');
  ev.fire({ tabId: 7, frameId: 0, error: 'net::ERR_CONNECTION_REFUSED', url: 'http://x/' });
  assert.equal(w.errorFor(7), null);
});

test('il messaggio nomina l\'errore di rete, l\'URL e la scheda', () => {
  const m = navErrorMessage({ error: 'net::ERR_CONNECTION_REFUSED', url: 'http://127.0.0.1:9/' }, 41);
  assert.match(m, /^net::ERR_CONNECTION_REFUSED loading http:\/\/127\.0\.0\.1:9\/ \(tab 41/);
});
