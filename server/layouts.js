/**
 * window_layout: salvare e ripristinare disposizioni di finestre per nome.
 *
 * Una sola implementazione per il tool MCP (tools.js) e per la CLI (cli.js):
 * prima viveva inline nel tool e la CLI non la conosceva, e `claude-master
 * layout save` usciva con «Unknown command: window_layout».
 *
 * Tutto lato server, componendo GET_TABS(include_windows) e VIEWPORT_RESIZE:
 * nessun comando nuovo verso l'estensione. Gli id delle finestre non
 * sopravvivono al riavvio del browser: il ripristino riconosce le finestre
 * dagli URL delle loro schede (miglior sovrapposizione, a parità di tipo).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { MessageType } from './protocol.js';

export const LAYOUTS_FILE = process.env.CHROME_BRIDGE_LAYOUTS_FILE
  || join(homedir(), '.config', 'chrome-bridge', 'layouts.json');

/**
 * @param {(type: string, params?: object) => Promise<any>} send  invio di un comando all'estensione
 * @param {{ action: 'save'|'restore'|'list'|'delete', name?: string }} p
 * @returns {Promise<object>} dati puri (il tool MCP li serializza, la CLI li stampa)
 */
export async function windowLayout(send, { action, name }) {
  const readLayouts = async () => {
    try { return JSON.parse(await readFile(LAYOUTS_FILE, 'utf8')); } catch { return {}; }
  };

  if (action === 'list') {
    const all = await readLayouts();
    const rows = Object.entries(all).map(([n, l]) => ({ name: n, windows: l.windows.length, savedAt: l.savedAt }));
    return { layouts: rows };
  }

  if (!name || !/^[\w-]+$/.test(name)) throw new Error('name is required and must match [\\w-]+');

  if (action === 'delete') {
    const all = await readLayouts();
    const existed = Boolean(all[name]);
    delete all[name];
    await mkdir(dirname(LAYOUTS_FILE), { recursive: true });
    await writeFile(LAYOUTS_FILE, JSON.stringify(all, null, 2));
    return { deleted: name, existed };
  }

  // save e restore hanno bisogno della fotografia corrente
  const snap = await send(MessageType.GET_TABS, { include_windows: true });
  if (Array.isArray(snap) || !snap?.windows) {
    // Un'estensione < 1.14.0 risponde con il solo array di schede: meglio
    // dirlo che fallire su una proprietà mancante.
    throw new Error('window_layout needs extension >= 1.14.0: get_tabs returned no window geometry');
  }
  const urlsByWindow = new Map();
  for (const t of snap.tabs || []) {
    if (!urlsByWindow.has(t.windowId)) urlsByWindow.set(t.windowId, []);
    urlsByWindow.get(t.windowId).push(t.url || '');
  }

  if (action === 'save') {
    const all = await readLayouts();
    all[name] = {
      savedAt: new Date().toISOString(),
      windows: snap.windows.map((w) => ({
        type: w.type,
        state: w.state,
        left: w.left, top: w.top, width: w.width, height: w.height,
        tabs: urlsByWindow.get(w.id) || [],
      })),
    };
    await mkdir(dirname(LAYOUTS_FILE), { recursive: true });
    await writeFile(LAYOUTS_FILE, JSON.stringify(all, null, 2));
    return { saved: name, windows: all[name].windows.length };
  }

  // restore
  const all = await readLayouts();
  const layout = all[name];
  if (!layout) {
    throw new Error(`Layout "${name}" not found — saved: ${Object.keys(all).join(', ') || 'none'}`);
  }

  // Matching: sovrapposizione degli URL (Jaccard), a parità di tipo. Greedy
  // sulla coppia migliore. Gli id non entrano mai: non sopravvivono al
  // riavvio del browser.
  const current = snap.windows.map((w) => ({ ...w, urls: new Set(urlsByWindow.get(w.id) || []) }));
  const pairs = [];
  layout.windows.forEach((savedWin, si) => {
    current.forEach((cur, ci) => {
      if (savedWin.type !== cur.type) return;
      const savedUrls = new Set(savedWin.tabs);
      let shared = 0;
      for (const u of savedUrls) if (cur.urls.has(u)) shared += 1;
      const union = new Set([...savedUrls, ...cur.urls]).size || 1;
      const score = shared / union;
      if (score > 0) pairs.push({ si, ci, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score);

  const usedSaved = new Set();
  const usedCurrent = new Set();
  const results = [];
  for (const { si, ci, score } of pairs) {
    if (usedSaved.has(si) || usedCurrent.has(ci)) continue;
    usedSaved.add(si); usedCurrent.add(ci);
    const savedWin = layout.windows[si];
    const cur = current[ci];
    const anyTab = (snap.tabs || []).find((t) => t.windowId === cur.id);
    if (!anyTab) { results.push({ window_id: cur.id, error: 'no tab to address the window with' }); continue; }
    // Una finestra da massimizzare riceve SOLO lo stato: i bounds verrebbero
    // accettati e ignorati, e il confronto richiesto/ottenuto mentirebbe.
    const params = savedWin.state === 'normal'
      ? { tab_id: anyTab.id, left: savedWin.left, top: savedWin.top, width: savedWin.width, height: savedWin.height, state: 'normal' }
      : { tab_id: anyTab.id, state: savedWin.state };
    try {
      const r = await send(MessageType.VIEWPORT_RESIZE, params);
      results.push({ window_id: cur.id, score: Number(score.toFixed(2)), requested: params, window: r?.window ?? r?.actual ?? null });
    } catch (e) {
      results.push({ window_id: cur.id, score: Number(score.toFixed(2)), error: e.message });
    }
  }

  const unmatchedSaved = layout.windows.filter((_, i) => !usedSaved.has(i)).length;
  const unmatchedCurrent = current.filter((_, i) => !usedCurrent.has(i)).map((w) => w.id);
  return {
    restored: name,
    matched: results.length,
    unmatched_saved: unmatchedSaved,
    unmatched_current: unmatchedCurrent,
    results,
  };
}
