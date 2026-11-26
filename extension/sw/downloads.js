/**
 * manage_downloads e capture_files (capture_downloads). I listener di chrome.downloads e di webNavigation restano in service-worker.js.
 * Parte di service-worker.js, che lo importa: vedi la nota in testa a quel file.
 */
import { classifyDownload } from '../lib/download-state.js';
import { downloadName } from '../lib/capture-names.js';
import { resolveTabId, scriptTarget } from './tab-target.js';
import { blobToBase64 } from './screen-capture.js';

// --- manage_downloads ---

export async function cmdManageDownloads({ action, url, filename, timeout = 30000, limit = 10 }) {
  if (!action) throw new Error('Missing required parameter: action');

  if (action === 'download') {
    if (!url) throw new Error('action=download requires url');
    // Parte dal browser, quindi con i cookie di sessione dell'origine: un file
    // dietro login si scarica senza far passare i byte dal bridge.
    const opts = { url, saveAs: false };
    if (filename) opts.filename = filename;
    const id = await chrome.downloads.download(opts);
    // Non basta l'id: su ChromeOS l'impostazione «Chiedi dove salvare ogni file»
    // scavalca saveAs:false e apre il selettore, quindi il download resta fermo
    // ad aspettare una persona. Una breve occhiata allo stato reale distingue
    // "partito" da "in attesa di te".
    await new Promise((r) => setTimeout(r, 600));
    const [item] = await chrome.downloads.search({ id });
    return { id, url, ...classifyDownload(item) };
  }

  if (action === 'list') {
    const items = await chrome.downloads.search({ orderBy: ['-startTime'], limit });
    return {
      downloads: items.map((d) => ({
        id: d.id, url: d.url, filename: d.filename, state: d.state,
        bytesReceived: d.bytesReceived, totalBytes: d.totalBytes,
        startTime: d.startTime, error: d.error || null,
      })),
    };
  }

  if (action === 'wait_for_complete') {
    const started = Date.now();
    let trackedId = null;

    while (Date.now() - started < timeout) {
      const items = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 5 });

      if (trackedId !== null) {
        const tracked = items.find((d) => d.id === trackedId);
        if (tracked) {
          if (tracked.state === 'complete') {
            return { completed: true, id: tracked.id, filename: tracked.filename, url: tracked.url, totalBytes: tracked.totalBytes };
          }
          if (tracked.state === 'interrupted') {
            return { completed: false, error: tracked.error, filename: tracked.filename };
          }
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        trackedId = null; // il download tracciato è sparito dai risultati
      }

      const inProgress = items.find((d) => d.state === 'in_progress');
      if (inProgress) {
        trackedId = inProgress.id;
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }

      const recent = items.find((d) => d.state === 'complete' && new Date(d.startTime).getTime() >= started - 5000);
      if (recent) {
        return { completed: true, id: recent.id, filename: recent.filename, url: recent.url, totalBytes: recent.totalBytes };
      }

      await new Promise((r) => setTimeout(r, 250));
    }
    return { completed: false, error: 'timeout', note: `No download completed within ${timeout}ms` };
  }

  throw new Error(`Unknown action: ${action}`);
}

// --- capture_downloads ---

/**
 * I file che la pagina crea o scarica arrivano al server senza la finestra
 * «Salva con nome» (14/10/2026). Due vie:
 * - nella pagina, lib/capture-hook.js prende blob, data URL e
 *   showSaveFilePicker prima che diventino un download;
 * - qui, un download che parte comunque mentre la scheda è armata viene
 *   annullato appena creato, e i byte si riprendono con i cookie del browser
 *   (http/https), dalla pagina (blob:) o dall'URL stesso (data:).
 * I byte restano nella pagina o qui finché il server li legge a pezzi.
 */
export const captureArmed = new Map();   // tabId → { max }
const captureItems = new Map();   // id → { tabId, name, mime, size, bytes, source, error, url, pending }
let captureSeq = 0;

export async function injectCaptureHook(tabId, max, frameIds) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
  await chrome.scripting.executeScript({ target, files: ['lib/capture-hook.js'], world: 'MAIN', injectImmediately: true });
  await chrome.scripting.executeScript({ target, func: (m) => window.__cbCapture?.arm(m), args: [max], world: 'MAIN', injectImmediately: true });
}

function captureTabFor(item) {
  if (captureArmed.size === 1) return captureArmed.keys().next().value;
  return null;
}

export async function captureDownload(item) {
  if (!captureArmed.size || item.byExtensionId === chrome.runtime.id) return;
  let tabId = captureTabFor(item);
  if (tabId == null) {
    const ref = item.referrer || item.url;
    for (const id of captureArmed.keys()) {
      try {
        const tab = await chrome.tabs.get(id);
        if (tab.url && ref && new URL(tab.url).origin === new URL(ref).origin) { tabId = id; break; }
      } catch {}
    }
    tabId ??= captureArmed.keys().next().value;
  }
  const { max } = captureArmed.get(tabId);
  // Prima di tutto fermarlo: la finestra di salvataggio non deve aprirsi.
  let browserCopy = null;
  try { await chrome.downloads.cancel(item.id); } catch {}
  try {
    const [now] = await chrome.downloads.search({ id: item.id });
    if (now?.state === 'complete') browserCopy = now.filename;
    else await chrome.downloads.erase({ id: item.id });
  } catch {}

  const url = item.finalUrl || item.url;
  const id = `d${Date.now().toString(36)}${(captureSeq++).toString(36)}`;
  const entry = { id, tabId, name: '', mime: item.mime || '', source: 'download', url, pending: true, ...(browserCopy && { browser_copy: browserCopy }) };
  captureItems.set(id, entry);
  try {
    if (/^blob:/i.test(url)) {
      // Il Blob vive nella pagina: lo prende l'hook, che lo tiene in mappa
      // anche se la pagina ha già chiamato revokeObjectURL.
      const origin = url.slice(5).replace(/\/[^/]*$/, '');
      const probes = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true }, world: 'MAIN',
        func: (u, o) => (window.__cbCapture?.blobs.has(u) ? 2 : (location.origin === o ? 1 : 0)),
        args: [url, origin],
      });
      const best = probes.filter((r) => r.result > 0).sort((a, b) => b.result - a.result)[0];
      if (!best) throw new Error('blob URL from a frame without capture hook');
      captureItems.delete(id);
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [best.frameId] }, world: 'MAIN',
        func: (u, n) => window.__cbCapture?.fromUrl(u, n, 'download').then(() => true),
        args: [url, item.filename ? item.filename.split(/[\\/]/).pop() : ''],
      });
      return;
    }
    const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
    const declared = Number(res.headers.get('content-length') || 0);
    entry.mime = res.headers.get('content-type') || entry.mime;
    let pageName = '';
    try {
      const probes = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true }, world: 'MAIN',
        func: (u) => window.__cbCapture?.names.get(u) ?? '',
        args: [item.url],
      });
      pageName = probes.map((r) => r.result).find(Boolean) || '';
    } catch {}
    entry.name = downloadName({ disposition: res.headers.get('content-disposition'), chromeName: item.filename, pageName, url: res.url || url });
    if (!res.ok) throw new Error(`refetch answered HTTP ${res.status} (a POST download or a one-time link cannot be fetched again)`);
    if (declared > max) {
      try { await res.body?.cancel(); } catch {}
      throw new Error(`too large: ${declared} bytes, max_mb allows ${max}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > max) throw new Error(`too large: ${bytes.length} bytes, max_mb allows ${max}`);
    entry.bytes = bytes;
    entry.size = bytes.length;
  } catch (e) {
    entry.error = e.message;
  }
  delete entry.pending;
}

export async function cmdCaptureFiles({ op, tab_id, max_bytes, id, frame_id, offset = 0, length = 4 * 1024 * 1024 }) {
  const tabId = await resolveTabId(tab_id);
  if (op === 'arm') {
    const max = Math.max(1, Number(max_bytes) || 100 * 1024 * 1024);
    captureArmed.set(tabId, { max });
    await injectCaptureHook(tabId, max);
    return { armed: true, tabId, max_bytes: max };
  }
  if (op === 'disarm') {
    captureArmed.delete(tabId);
    for (const [k, v] of captureItems) if (v.tabId === tabId) captureItems.delete(k);
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: () => window.__cbCapture?.disarm() });
    } catch {}
    return { armed: false, tabId };
  }
  if (op === 'list') {
    const items = [];
    let frames = [];
    try {
      frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: () => window.__cbCapture?.list() ?? null });
    } catch {}
    for (const f of frames) for (const it of f.result ?? []) items.push({ ...it, frame_id: f.frameId });
    for (const v of captureItems.values()) {
      if (v.tabId !== tabId) continue;
      const { bytes, tabId: _t, ...meta } = v;
      items.push(meta);
    }
    return { armed: captureArmed.has(tabId), tabId, items };
  }
  if (op === 'read') {
    if (!id) throw new Error('Missing required parameter: id');
    const held = captureItems.get(id);
    if (held) {
      if (!held.bytes) throw new Error(`capture: ${id} has no bytes (${held.error || 'pending'})`);
      return { b64: await blobToBase64(new Blob([held.bytes.subarray(offset, offset + length)])) };
    }
    const [r] = await chrome.scripting.executeScript({
      target: scriptTarget(tabId, frame_id ?? 0), world: 'MAIN',
      func: (i, o, l) => window.__cbCapture ? window.__cbCapture.read(i, o, l) : Promise.reject(new Error('capture hook gone: the page was reloaded')),
      args: [id, offset, length],
    });
    if (r?.error) throw new Error(r.error.message || String(r.error));
    if (typeof r?.result !== 'string') throw new Error(`capture: could not read ${id}`);
    return { b64: r.result };
  }
  if (op === 'drop') {
    if (!id) throw new Error('Missing required parameter: id');
    if (captureItems.delete(id)) return { dropped: id };
    try {
      await chrome.scripting.executeScript({ target: scriptTarget(tabId, frame_id ?? 0), world: 'MAIN', func: (i) => window.__cbCapture?.drop(i), args: [id] });
    } catch {}
    return { dropped: id };
  }
  throw new Error(`Unknown capture op: ${op}`);
}
