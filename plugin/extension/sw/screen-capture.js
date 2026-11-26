/**
 * Cattura della scheda visibile, pagina nascosta e scadenze, conversione delle immagini in base64.
 * Parte di service-worker.js, che lo importa: vedi la nota in testa a quel file.
 */
import { createPacer } from '../lib/capture-pacing.js';

// --- Utility: captureVisibleTab con timeout ---
// Su ChromeOS una finestra totalmente occlusa/congelata può non produrre mai
// un frame: la promise di captureVisibleTab resterebbe pendente per sempre.
// Meglio un errore parlante dopo 10s che un comando appeso.
// Quota Chrome: 2 catture al secondo. Il pacer distanzia le chiamate di
// 520 ms invece di far comparire MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND al
// secondo screenshot ravvicinato (trovato dal bench di latenza, 2026-09-11).
const paceCapture = createPacer();

async function captureVisible(windowId, options = { format: 'png' }) {
  await paceCapture();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Capture timed out after 10s: the window is not rendering frames (fully occluded, minimized, or frozen). Bring the Chrome window at least partially on screen and retry.'));
    }, 10000);
    chrome.tabs.captureVisibleTab(windowId, options).then(
      (dataUrl) => { clearTimeout(timer); resolve(dataUrl); },
      (err) => {
        clearTimeout(timer);
        // «image readback failed» è lo stesso guasto della finestra che non
        // disegna, detto dal compositor: stesso messaggio, stesso rimedio.
        if (/readback failed/i.test(err?.message || '')) {
          reject(new Error(`Capture failed (${err.message}): the window is not rendering frames (fully occluded, minimized, or frozen). Bring the Chrome window at least partially on screen and retry.`));
        } else {
          reject(err);
        }
      },
    );
  });
}

// --- Utility: scadenze tenute dal service worker ---
// Le attese che girano nella pagina usano setTimeout, e Chrome raggruppa i
// timer delle pagine nascoste fino a un risveglio al minuto: il controllo
// della scadenza scattava tardi e vinceva il timeout di trasporto (60 s per
// un'attesa da 25, osservato su Meta Ads Manager il 23/09/2026). Il service
// worker non è rallentato: la scadenza la tiene lui.
export const HIDDEN_HINT = 'The page is hidden (window minimized, covered or in the background): Chrome slows its timers and stops rendering. Bring the window on screen, or create_tab new_window with bounds, then retry.';

export async function pageHidden(tabId) {
  try {
    const q = chrome.scripting.executeScript({ target: { tabId }, func: () => document.visibilityState === 'hidden' });
    const r = await Promise.race([q, new Promise((res) => setTimeout(() => res(null), 1000))]);
    return r?.[0]?.result === true;
  } catch {
    return false;
  }
}

// Cattura della scheda solo se la pagina è visibile: su una finestra coperta o
// in secondo piano captureVisibleTab restituiva l'ultimo fotogramma disegnato,
// cioè un'immagine vecchia senza nessun avviso (osservato il 28/09/2026: modulo
// già compilato, screenshot con i campi vuoti). Su chrome:// lo script non entra
// e pageHidden dice false: lì si cattura come prima.
export async function captureVisibleOf(tab) {
  if (await pageHidden(tab.id)) throw new Error(`No screenshot taken: it would be a stale frame. ${HIDDEN_HINT}`);
  return captureVisible(tab.windowId);
}

// Esegue run(); se non risponde entro deadlineMs restituisce onTimeout. In
// entrambi i casi un esito negativo su pagina nascosta porta page_hidden e il
// suggerimento, così chi chiama non ritenta tre volte la stessa attesa.
export async function withDeadline(tabId, deadlineMs, run, onTimeout, isNegative) {
  const DEADLINE = Symbol('deadline');
  let timer;
  let result;
  try {
    result = await Promise.race([
      run(),
      new Promise((res) => { timer = setTimeout(() => res(DEADLINE), deadlineMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (result === DEADLINE) result = { ...onTimeout };
  if (result && isNegative(result) && await pageHidden(tabId)) {
    return { ...result, page_hidden: true, hint: HIDDEN_HINT };
  }
  return result;
}

// --- Utility: rendi visibile un tab per la cattura SENZA rubare il focus OS ---
// captureVisibleTab richiede solo che il tab sia attivo nella sua finestra,
// non che la finestra sia in primo piano. Al termine ripristina il tab che
// era attivo prima e l'eventuale stato minimized della finestra.

// Una cattura per finestra alla volta: due catture concorrenti nella stessa
// finestra si scambiavano la scheda attiva e una poteva fotografare quella
// dell'altra.
const windowLocks = new Map();
export async function withTabVisible(tabId, fn) {
  const { windowId } = await chrome.tabs.get(tabId);
  const prev = windowLocks.get(windowId) ?? Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  windowLocks.set(windowId, chain);
  await prev;
  try {
    return await withTabVisibleUnlocked(tabId, fn);
  } finally {
    release();
    if (windowLocks.get(windowId) === chain) windowLocks.delete(windowId);
  }
}

async function withTabVisibleUnlocked(tabId, fn) {
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  const [prevActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  const restoreTabId = prevActive && prevActive.id !== tabId ? prevActive.id : null;
  const wasMinimized = win.state === 'minimized';

  if (wasMinimized) await chrome.windows.update(tab.windowId, { state: 'normal', focused: false });
  if (!tab.active) await chrome.tabs.update(tabId, { active: true });
  try {
    return await fn(tab);
  } finally {
    if (restoreTabId) {
      try { await chrome.tabs.update(restoreTabId, { active: true }); } catch { /* tab chiuso nel frattempo */ }
    }
    if (wasMinimized) {
      try { await chrome.windows.update(tab.windowId, { state: 'minimized' }); } catch { /* finestra chiusa */ }
    }
  }
}

// --- Helper immagini (OffscreenCanvas nel service worker) ---

export async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return await createImageBitmap(blob);
}

export async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function canvasToBase64(canvas) {
  return blobToBase64(await canvas.convertToBlob({ type: 'image/png' }));
}

// I client LLM ridimensionano comunque le immagini a ~1568px sul lato lungo:
// pixel oltre quella soglia non arrivano mai al modello, gonfiano solo il
// payload base64. Downscale qui = stesso dettaglio percepito, meno byte.
export const MAX_IMAGE_SIDE = 1568;

// Stessa regola per un canvas già disegnato (es. l'immagine di diff): senza
// questo, screenshot_diff era l'unico output visuale fuori dal cap.
export async function canvasToBase64Capped(canvas, maxSide = MAX_IMAGE_SIDE) {
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  if (scale === 1) return await canvasToBase64(canvas);
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const out = new OffscreenCanvas(w, h);
  out.getContext('2d').drawImage(canvas, 0, 0, w, h);
  return await canvasToBase64(out);
}

export async function bitmapToBase64Capped(bitmap, maxSide = MAX_IMAGE_SIDE) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return await canvasToBase64(canvas);
}
