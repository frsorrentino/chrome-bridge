/**
 * Gruppo perf: motion, perf_trace, screencast, cdp_target. Il listener di chrome.debugger che riempie traces e casts resta in service-worker.js.
 * Parte di service-worker.js, che lo importa: vedi la nota in testa a quel file.
 */
import { resolveTabId, scriptTarget } from './tab-target.js';
import { HIDDEN_HINT, pageHidden } from './screen-capture.js';
import { holdDebugger, releaseDebugger, debuggerHeld } from '../lib/trusted-input.js';

// --- motion (animations, frames) ---

// lib/motion.js tiene la logica (testata in Node); qui solo l'iniezione. Una
// finestra di registrazione su pagina nascosta misurerebbe il nulla: rAF e
// osservatori si fermano, quindi start rifiuta invece di restituire zeri.
export async function cmdMotion({ op, scope = null, limit, threshold_ms, tab_id, frame_id }) {
  const tabId = await resolveTabId(tab_id);
  if (op === 'start' && await pageHidden(tabId)) throw new Error(`Not recording: ${HIDDEN_HINT}`);
  const target = scriptTarget(tabId, frame_id);
  if (op !== 'stop') await chrome.scripting.executeScript({ target, files: ['lib/motion.js'], world: 'MAIN' });
  const results = await chrome.scripting.executeScript({
    target,
    func: (o, opts) => {
      const m = globalThis.__cbMotion;
      if (!m) return { error: 'No recording in this page: it was never started, or the page navigated and lost it.' };
      return m[o](opts);
    },
    args: [op, { scope, ...(limit != null && { limit }), ...(threshold_ms != null && { threshold_ms }) }],
    world: 'MAIN',
  });
  const out = results?.[0]?.result;
  if (out?.error) throw new Error(out.error);
  return out;
}

// --- perf_trace ---

// Categorie del pannello Performance di DevTools (come chrome-devtools-mcp),
// senza gli screenshot che gonfiano il file. Il trace torna come stream: il
// server lo legge a pezzi (op read) e lo scrive su disco, così nel service
// worker non resta mai tutto in memoria.
const TRACE_CATEGORIES = [
  '-*', 'blink.console', 'blink.user_timing', 'devtools.timeline', 'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-devtools.timeline.stack',
  'disabled-by-default-devtools.timeline.invalidationTracking', 'disabled-by-default-v8.cpu_profiler',
  'latencyInfo', 'loading', 'disabled-by-default-lighthouse', 'v8.execute', 'v8',
];
export const traces = new Map();  // tabId → { complete: Promise<handle>, stream }

// --- screencast ---

// I fotogrammi arrivano solo se la scheda è attiva e visibile (prova del
// 01/10: zero in secondo piano), e solo quando la pagina cambia.
export const casts = new Map();  // tabId → { frames, total, dropped }
export const CAST_BUFFER_MAX = 600;

export async function cmdScreencast({ op, quality = 70, max_width, max_height, every_nth = 1, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  if (op === 'start') {
    if (casts.has(tabId)) throw new Error('A screencast is already running on this tab: screencast stop first');
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) throw new Error('Screencast needs the tab active in its window: Chrome sends no frames for a background tab. Use tab_action activate first.');
    if (await pageHidden(tabId)) throw new Error(`Not recording: ${HIDDEN_HINT}`);
    const send = await holdDebugger(tabId, 'screencast', 'screencast');
    casts.set(tabId, { frames: [], total: 0, dropped: 0 });
    try {
      await send('Page.startScreencast', { format: 'jpeg', quality, everyNthFrame: every_nth, ...(max_width && { maxWidth: max_width }), ...(max_height && { maxHeight: max_height }) });
    } catch (e) {
      casts.delete(tabId);
      await releaseDebugger(tabId, 'screencast');
      throw e;
    }
    return { recording: true };
  }
  const c = casts.get(tabId);
  if (!c) throw new Error('No screencast running on this tab: screencast start first');
  if (op === 'drain') {
    const frames = c.frames.splice(0);
    return { frames, total: c.total, dropped: c.dropped, held: debuggerHeld(tabId).held };
  }
  if (op === 'stop') {
    await chrome.debugger.sendCommand({ tabId }, 'Page.stopScreencast', {}).catch(() => {});
    casts.delete(tabId);
    await releaseDebugger(tabId, 'screencast');
    return { frames: c.frames.splice(0), total: c.total, dropped: c.dropped };
  }
  throw new Error(`Unknown screencast op ${op}`);
}

export async function cmdPerfTrace({ op, reload = false, screenshots = false, size = 4 * 1024 * 1024, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const send = (m, p) => chrome.debugger.sendCommand({ tabId }, m, p);
  if (op === 'start') {
    if (traces.has(tabId)) throw new Error('A trace is already recording on this tab: perf_trace stop first');
    if (await pageHidden(tabId)) throw new Error(`Not tracing: ${HIDDEN_HINT}`);
    await holdDebugger(tabId, 'trace', 'perf_trace');
    let resolveComplete;
    const complete = new Promise((r) => { resolveComplete = r; });
    traces.set(tabId, { complete, resolveComplete });
    try {
      await send('Tracing.start', {
        transferMode: 'ReturnAsStream', streamFormat: 'json', streamCompression: 'none',
        traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: [...TRACE_CATEGORIES, ...(screenshots ? ['disabled-by-default-devtools.screenshot'] : [])] },
      });
    } catch (e) {
      traces.delete(tabId);
      await releaseDebugger(tabId, 'trace');
      throw e;
    }
    if (reload) await chrome.tabs.reload(tabId, { bypassCache: false });
    return { tracing: true, debugger_bar: true };
  }
  if (op === 'stop') {
    const t = traces.get(tabId);
    if (!t) throw new Error('No trace recording on this tab: perf_trace start first');
    if (!debuggerHeld(tabId).held) { traces.delete(tabId); throw new Error('The debugger was detached (bar cancelled or tab closed): the trace is lost'); }
    await send('Tracing.end', {});
    const stream = await Promise.race([t.complete, new Promise((_, rej) => setTimeout(() => rej(new Error('Trace did not complete within 30 s')), 30000))]);
    t.stream = stream;
    return { stream };
  }
  if (op === 'read') {
    const t = traces.get(tabId);
    if (!t?.stream) throw new Error('No finished trace to read: perf_trace stop first');
    const chunk = await send('IO.read', { handle: t.stream, size });
    if (chunk.eof) {
      await send('IO.close', { handle: t.stream }).catch(() => {});
      traces.delete(tabId);
      await releaseDebugger(tabId, 'trace');
    }
    return { data: chunk.data, base64: Boolean(chunk.base64Encoded), eof: Boolean(chunk.eof) };
  }
  if (op === 'abort') {
    traces.delete(tabId);
    await send('Tracing.end', {}).catch(() => {});
    return { aborted: await releaseDebugger(tabId, 'trace') };
  }
  throw new Error(`Unknown perf_trace op ${op}`);
}

// --- cdp_target ---

// Id CDP della scheda, per i tool che in modalità launch parlano con la porta
// di debug (heap_snapshot): l'id della scheda di chrome.tabs non vale lì.
export async function cmdCdpTarget({ tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const target = (await chrome.debugger.getTargets()).find((t) => t.tabId === tabId);
  if (!target) throw new Error(`No debugger target for tab ${tabId}`);
  return { target_id: target.id, url: target.url };
}
