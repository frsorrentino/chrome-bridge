/**
 * Input fidato via chrome.debugger: eventi con isTrusted=true, generati dal
 * browser e non dalla pagina. Serve dove l'evento sintetico non basta: widget
 * che scartano gli eventi non fidati, editor che leggono solo input nativo,
 * scorciatoie di tastiera gestite dal browser.
 *
 * Il debugger si aggancia solo per la durata dell'azione e si stacca subito:
 * la barra «sta eseguendo il debug» compare solo in quel momento. Eccezione:
 * una scheda «tenuta» (holdDebugger, per l'emulazione di emulate_media, che
 * vive solo finché il debugger è agganciato) resta agganciata fino al
 * rilascio, e withDebugger usa quell'aggancio senza staccarlo.
 */

// Tasti con nome: code e keyCode di Windows che Input.dispatchKeyEvent vuole
// per produrre gli effetti di default (Enter invia, Tab sposta il fuoco).
const NAMED = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Space: { code: 'Space', keyCode: 32, text: ' ', key: ' ' },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
};

/** Bitmask dei modificatori di CDP: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function modifierMask({ ctrl = false, shift = false, alt = false, meta = false } = {}) {
  return (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
}

/**
 * Parametri di keyDown e keyUp per Input.dispatchKeyEvent. Con un modificatore
 * diverso da Shift il tasto non produce testo: Ctrl+A seleziona, non scrive «a».
 */
export function keyEvents(key, mods = {}) {
  const modifiers = modifierMask(mods);
  const named = NAMED[key];
  let base;
  if (named) {
    base = { key: named.key ?? key, code: named.code, windowsVirtualKeyCode: named.keyCode, text: named.text };
  } else if (typeof key === 'string' && key.length === 1) {
    const upper = key.toUpperCase();
    const isLetter = /[A-Z]/.test(upper);
    const isDigit = /[0-9]/.test(key);
    base = {
      key,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${key}` : '',
      windowsVirtualKeyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      text: key,
    };
  } else {
    base = { key, code: key, windowsVirtualKeyCode: 0 };
  }
  const printable = base.text != null && !(modifiers & (1 | 2 | 4));
  const down = { type: printable ? 'keyDown' : 'rawKeyDown', modifiers, key: base.key, code: base.code, windowsVirtualKeyCode: base.windowsVirtualKeyCode };
  if (printable) { down.text = base.text; down.unmodifiedText = base.text; }
  const up = { type: 'keyUp', modifiers, key: base.key, code: base.code, windowsVirtualKeyCode: base.windowsVirtualKeyCode };
  return [down, up];
}

/** Sequenza di un click fidato al punto (x, y) in CSS px del viewport. */
export function mouseClickEvents(x, y, { button = 'left', count = 1 } = {}) {
  const events = [{ type: 'mouseMoved', x, y }];
  for (let i = 1; i <= Math.max(1, count); i++) {
    events.push({ type: 'mousePressed', x, y, button, clickCount: i });
    events.push({ type: 'mouseReleased', x, y, button, clickCount: i });
  }
  return events;
}

// Schede tenute agganciate: tabId → insieme dei motivi ('emulation', …).
// Chrome stacca il debugger da solo quando l'utente preme «Annulla» sulla
// barra o la scheda si chiude: onDetach toglie la voce, e chi la teneva lo
// scopre con debuggerHeld.
const held = new Map();
let detachListener = false;

function listenDetach() {
  if (detachListener || !globalThis.chrome?.debugger?.onDetach) return;
  detachListener = true;
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId == null || !held.has(source.tabId)) return;
    held.delete(source.tabId);
    lastDetach.set(source.tabId, reason);
  });
}
const lastDetach = new Map();

async function attach(tabId, purpose) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/already attached/i.test(msg)) throw new Error(`${purpose} unavailable: another debugger (DevTools?) is attached to this tab — close it, or retry without it`);
    throw new Error(`${purpose} unavailable: ${msg}`);
  }
}

/** Tiene il debugger agganciato alla scheda per un motivo, finché releaseDebugger. */
export async function holdDebugger(tabId, why, purpose = why) {
  listenDetach();
  let reasons = held.get(tabId);
  if (!reasons) {
    await attach(tabId, purpose);
    reasons = new Set();
    held.set(tabId, reasons);
    lastDetach.delete(tabId);
  }
  reasons.add(why);
  return (method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
}

/** Toglie un motivo; senza più motivi il debugger si stacca e la barra sparisce. */
export async function releaseDebugger(tabId, why) {
  const reasons = held.get(tabId);
  if (!reasons) return false;
  reasons.delete(why);
  if (reasons.size) return true;
  held.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  return true;
}

/** Stato della tenuta: held, i motivi, o il motivo dello stacco (canceled_by_user, target_closed). */
export function debuggerHeld(tabId) {
  const reasons = held.get(tabId);
  if (reasons) return { held: true, reasons: [...reasons] };
  return { held: false, ...(lastDetach.has(tabId) && { detached: lastDetach.get(tabId) }) };
}

/**
 * Aggancia il debugger alla scheda, esegue fn(send) e si stacca sempre, anche
 * su errore. Un DevTools già aperto sulla scheda impedisce l'aggancio: lo dice.
 * Su una scheda tenuta usa l'aggancio esistente e non lo stacca.
 */
export async function withDebugger(tabId, fn) {
  const target = { tabId };
  const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  if (held.has(tabId)) return fn(send);
  await attach(tabId, 'trusted input');
  try {
    return await fn(send);
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}
