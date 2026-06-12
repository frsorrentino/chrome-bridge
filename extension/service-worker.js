/**
 * Chrome Bridge — Service Worker
 *
 * Mantiene una connessione WebSocket al server MCP in Crostini.
 * Riceve comandi, li esegue tramite Chrome APIs, e invia le risposte.
 */

const DEFAULT_PORT = 8765;
let wsUrl = `ws://localhost:${DEFAULT_PORT}`;
let extToken = '';

async function loadConfig() {
  const cfg = await chrome.storage.local.get({ port: DEFAULT_PORT, token: '' });
  wsUrl = `ws://localhost:${cfg.port}`;
  extToken = cfg.token || '';
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.port || changes.token) {
    loadConfig().then(() => {
      // Chiudi e lascia che scheduleReconnect riconnetta col nuovo URL
      if (ws) { try { ws.close(); } catch {} } else { connect(); }
    });
  }
});

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const KEEPALIVE_ALARM = 'chrome-bridge-keepalive';

let ws = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_BASE_MS;
let connectionState = 'disconnected'; // 'connected' | 'connecting' | 'disconnected'

// Tracking per tool stateful (network monkey-patch)
const injectedTabs = { network: new Set(), websocket: new Set() };

// --- Keep-alive: impedisce che il service worker venga fermato ---
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }); // 30s = minimo Chrome
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // Il solo fatto che l'handler esista tiene il service worker attivo
  }
});

// --- Listener per popup: getConnectionState ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getConnectionState') {
    sendResponse({ state: connectionState });
  }
});

// --- WebSocket connection ---

function connect() {
  clearTimeout(reconnectTimer);

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setConnectionState('connecting');

  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    console.error('[chrome-bridge] WebSocket creation error:', err);
    scheduleReconnect();
    return;
  }

  const socket = ws;

  ws.onopen = () => {
    console.log('[chrome-bridge] Connected to MCP server');
    const init = { type: 'ext_init' };
    if (extToken) init.token = extToken;
    ws.send(JSON.stringify(init));
    setConnectionState('connected');
    reconnectDelay = RECONNECT_BASE_MS; // Reset backoff
  };

  ws.onclose = () => {
    if (ws !== socket) return;
    console.log('[chrome-bridge] Disconnected from MCP server');
    ws = null;
    setConnectionState('disconnected');
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[chrome-bridge] WebSocket error:', err);
    // onclose verrà chiamato dopo onerror
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.error('[chrome-bridge] Invalid JSON from server');
      return;
    }

    // Gestisci ping
    if (msg.type === 'ping') {
      sendMessage({ type: 'pong', timestamp: Date.now() });
      return;
    }

    // Esegui il comando e rispondi
    try {
      const result = await executeCommand(msg);
      sendMessage({
        id: msg.id,
        type: 'result',
        data: result,
        timestamp: Date.now(),
      });
    } catch (err) {
      sendMessage({
        id: msg.id,
        type: 'error',
        error: err.message || String(err),
        timestamp: Date.now(),
      });
    }
  };
}

function scheduleReconnect() {
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    connect();
  }, reconnectDelay);
}

function sendMessage(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function setConnectionState(state) {
  connectionState = state;
  // Broadcast al popup
  chrome.runtime.sendMessage({ type: 'connectionState', state }).catch(() => {
    // Popup non aperto, ignora
  });
}

// --- Command dispatcher ---

async function executeCommand(msg) {
  const { type, params = {} } = msg;

  switch (type) {
    case 'get_tabs':
      return await cmdGetTabs();
    case 'navigate':
      return await cmdNavigate(params);
    case 'screenshot':
      return await cmdScreenshot(params);
    case 'execute_js':
      return await cmdExecuteJs(params);
    case 'click':
      return await cmdClick(params);
    case 'type_text':
      return await cmdTypeText(params);
    case 'read_page':
      return await cmdReadPage(params);
    case 'get_page_info':
      return await cmdGetPageInfo(params);
    case 'get_storage':
      return await cmdGetStorage(params);
    case 'get_performance':
      return await cmdGetPerformance(params);
    case 'query_dom':
      return await cmdQueryDom(params);
    case 'modify_dom':
      return await cmdModifyDom(params);
    case 'inject_css':
      return await cmdInjectCss(params);
    case 'read_console':
      return await cmdReadConsole(params);
    case 'monitor_network':
      return await cmdMonitorNetwork(params);
    case 'create_tab':
      return await cmdCreateTab(params);
    case 'wait_for_element':
      return await cmdWaitForElement(params);
    case 'scroll_to':
      return await cmdScrollTo(params);
    case 'set_storage':
      return await cmdSetStorage(params);
    case 'fill_form':
      return await cmdFillForm(params);
    case 'viewport_resize':
      return await cmdViewportResize(params);
    case 'full_page_screenshot':
      return await cmdFullPageScreenshot(params);
    case 'element_screenshot':
      return await cmdElementScreenshot(params);
    case 'highlight_elements':
      return await cmdHighlightElements(params);
    case 'accessibility_audit':
      return await cmdAccessibilityAudit(params);
    case 'collect_links':
      return await cmdCollectLinks(params);
    case 'measure_spacing':
      return await cmdMeasureSpacing(params);
    case 'watch_dom':
      return await cmdWatchDom(params);
    case 'emulate_media':
      return await cmdEmulateMedia(params);
    case 'hover':
      return await cmdHover(params);
    case 'press_key':
      return await cmdPressKey(params);
    case 'get_frames':
      return await cmdGetFrames(params);
    case 'tab_action':
      return await cmdTabAction(params);
    case 'upload_file':
      return await cmdUploadFile(params);
    case 'wait_for_navigation':
      return await cmdWaitForNavigation(params);
    case 'wait_for_network_idle':
      return await cmdWaitForNetworkIdle(params);
    case 'handle_dialogs':
      return await cmdHandleDialogs(params);
    case 'find_text':
      return await cmdFindText(params);
    case 'network_rules':
      return await cmdNetworkRules(params);
    case 'screenshot_diff':
      return await cmdScreenshotDiff(params);
    case 'web_vitals':
      return await cmdWebVitals(params);
    case 'list_event_listeners':
      return await cmdListEventListeners(params);
    case 'monitor_websocket':
      return await cmdMonitorWebsocket(params);
    case 'seo_audit':
      return await cmdSeoAudit(params);
    case 'extract_table':
      return await cmdExtractTable(params);
    case 'unused_css':
      return await cmdUnusedCss(params);
    case 'drag_and_drop':
      return await cmdDragAndDrop(params);
    case 'clipboard':
      return await cmdClipboard(params);
    case 'set_geolocation':
      return await cmdSetGeolocation(params);
    case 'manage_downloads':
      return await cmdManageDownloads(params);
    case 'save_page':
      return await cmdSavePage(params);
    case 'set_zoom':
      return await cmdSetZoom(params);
    case 'http_auth':
      return await cmdHttpAuth(params);
    case 'get_response_headers':
      return await cmdGetResponseHeaders(params);
    default:
      throw new Error(`Unknown command type: ${type}`);
  }
}

// --- Utility: waitForComplete ---

function waitForComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);
  });
}

// --- Utility: risolvi tab_id ---

async function resolveTabId(tab_id) {
  if (tab_id) return tab_id;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab.id;
}

// --- Utility: target per chrome.scripting con frame opzionale ---

function scriptTarget(tabId, frame_id) {
  const target = { tabId };
  if (frame_id !== undefined && frame_id !== null) target.frameIds = [frame_id];
  return target;
}

// --- Helper immagini (OffscreenCanvas nel service worker) ---

async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return await createImageBitmap(blob);
}

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function canvasToBase64(canvas) {
  return blobToBase64(await canvas.convertToBlob({ type: 'image/png' }));
}

// --- Implementazione comandi ---

async function cmdGetTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    id: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    windowId: t.windowId,
  }));
}

async function cmdNavigate({ url, tab_id }) {
  if (!url) throw new Error('Missing required parameter: url');
  const tabId = await resolveTabId(tab_id);

  // Registra il listener PRIMA di tabs.update: una navigazione veloce (cache)
  // può emettere 'complete' prima che il listener esista
  const done = waitForComplete(tabId);
  await chrome.tabs.update(tabId, { url });
  await done;

  const updatedTab = await chrome.tabs.get(tabId);
  return { url: updatedTab.url, title: updatedTab.title, tabId };
}

async function cmdScreenshot({ tab_id }) {
  const tabId = await resolveTabId(tab_id);

  // Assicurati che il tab sia attivo per fare lo screenshot
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });

  // Piccolo delay per dare tempo al rendering
  await new Promise((r) => setTimeout(r, 200));

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: 'png',
  });

  // Rimuovi il prefisso data:image/png;base64,
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  return { image: base64 };
}

async function cmdExecuteJs({ code, tab_id, frame_id }) {
  if (!code) throw new Error('Missing required parameter: code');
  const tabId = await resolveTabId(tab_id);

  // Strategia: ISOLATED world (no CSP restrizioni dalla pagina)
  // per accesso DOM + eval del codice utente.
  // Fallback: MAIN world per accesso a variabili della pagina.
  try {
    const results = await chrome.scripting.executeScript({
      target: scriptTarget(tabId, frame_id),
      func: (codeStr) => {
        // In ISOLATED world, eval non è soggetto alla CSP della pagina
        try {
          return eval(codeStr);
        } catch (e) {
          return { __error: e.message };
        }
      },
      args: [code],
      world: 'ISOLATED',
    });
    const val = results?.[0]?.result;
    if (val && typeof val === 'object' && val.__error) {
      throw new Error(val.__error);
    }
    return { result: val ?? null };
  } catch (isolatedErr) {
    // Fallback: prova MAIN world (funziona se la pagina non ha CSP restrittiva)
    try {
      const results = await chrome.scripting.executeScript({
        target: scriptTarget(tabId, frame_id),
        func: (codeStr) => {
          try {
            return eval(codeStr);
          } catch (e) {
            return { __error: e.message };
          }
        },
        args: [code],
        world: 'MAIN',
      });
      const val = results?.[0]?.result;
      if (val && typeof val === 'object' && val.__error) {
        throw new Error(val.__error);
      }
      return { result: val ?? null };
    } catch (mainErr) {
      throw new Error(`JS execution failed: ${isolatedErr.message}`);
    }
  }
}

async function cmdClick({ selector, tab_id, frame_id }) {
  if (!selector) throw new Error('Missing required parameter: selector');
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: scriptTarget(tabId, frame_id),
    func: (sel) => {
      function deepQuery(sel) {
        if (!sel.includes('>>>')) return document.querySelector(sel);
        const parts = sel.split('>>>').map((s) => s.trim());
        let ctx = document;
        for (let i = 0; i < parts.length; i++) {
          const found = ctx.querySelector(parts[i]);
          if (!found) return null;
          if (i === parts.length - 1) return found;
          if (!found.shadowRoot) return null;
          ctx = found.shadowRoot;
        }
        return null;
      }
      const el = deepQuery(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.click();
      return { tagName: el.tagName, text: el.textContent?.substring(0, 100) };
    },
    args: [selector],
    world: 'MAIN',
  });

  return results?.[0]?.result ?? { clicked: true };
}

async function cmdTypeText({ selector, text, mode = 'set', tab_id, frame_id }) {
  if (!selector) throw new Error('Missing required parameter: selector');
  if (text === undefined) throw new Error('Missing required parameter: text');
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: scriptTarget(tabId, frame_id),
    func: async (sel, txt, typeMode) => {
      function deepQuery(sel) {
        if (!sel.includes('>>>')) return document.querySelector(sel);
        const parts = sel.split('>>>').map((s) => s.trim());
        let ctx = document;
        for (let i = 0; i < parts.length; i++) {
          const found = ctx.querySelector(parts[i]);
          if (!found) return null;
          if (i === parts.length - 1) return found;
          if (!found.shadowRoot) return null;
          ctx = found.shadowRoot;
        }
        return null;
      }
      const el = deepQuery(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);
      el.focus();
      const tag = el.tagName.toLowerCase();
      // Native setter: i controlled input React ignorano l'assegnazione diretta
      const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = (tag === 'input' || tag === 'textarea')
        ? Object.getOwnPropertyDescriptor(proto, 'value')?.set
        : null;
      const setValue = (value) => {
        if (tag === 'input' || tag === 'textarea') {
          if (setter) setter.call(el, value); else el.value = value;
        } else if (el.isContentEditable) {
          el.textContent = value;
        } else {
          el.value = value;
        }
      };
      const getValue = () => {
        if (tag === 'input' || tag === 'textarea') return el.value;
        if (el.isContentEditable) return el.textContent;
        return el.value ?? '';
      };

      if (typeMode === 'keys') {
        // Eventi tastiera carattere per carattere: per autocomplete/input mascherati
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (const ch of txt) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
          setValue((getValue() ?? '') + ch);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true, cancelable: true }));
          await sleep(10);
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { typed: true, tagName: tag, mode: 'keys' };
      }

      setValue(txt);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { typed: true, tagName: tag };
    },
    args: [selector, text, mode],
    world: 'MAIN',
  });

  return results?.[0]?.result ?? { typed: true };
}

async function cmdReadPage({ mode = 'text', tab_id, frame_id }) {
  const tabId = await resolveTabId(tab_id);

  if (mode === 'html') {
    const results = await chrome.scripting.executeScript({
      target: scriptTarget(tabId, frame_id),
      func: () => document.documentElement.outerHTML,
      world: 'MAIN',
    });
    return results?.[0]?.result ?? '';
  }

  if (mode === 'accessibility') {
    // Ritorna una struttura semplificata dell'a11y tree
    const results = await chrome.scripting.executeScript({
      target: scriptTarget(tabId, frame_id),
      func: () => {
        function walk(el, depth = 0) {
          if (depth > 10) return '';
          const role = el.getAttribute('role') || el.tagName.toLowerCase();
          const label = el.getAttribute('aria-label') || el.textContent?.substring(0, 50)?.trim() || '';
          let output = `${'  '.repeat(depth)}[${role}] ${label}\n`;
          for (const child of el.children) {
            output += walk(child, depth + 1);
          }
          return output;
        }
        return walk(document.body);
      },
      world: 'MAIN',
    });
    return results?.[0]?.result ?? '';
  }

  // mode === 'text' (default)
  const results = await chrome.scripting.executeScript({
    target: scriptTarget(tabId, frame_id),
    func: () => document.body.innerText,
    world: 'MAIN',
  });
  return results?.[0]?.result ?? '';
}

// --- create_tab ---

async function cmdCreateTab({ url, active = true }) {
  const opts = { active };
  if (url) opts.url = url;
  const tab = await chrome.tabs.create(opts);
  // Attendi caricamento se c'è un URL
  if (url) {
    await waitForComplete(tab.id);
    const updated = await chrome.tabs.get(tab.id);
    return { id: updated.id, url: updated.url, title: updated.title };
  }
  return { id: tab.id, url: tab.url || 'chrome://newtab', title: tab.title || '' };
}

// --- tab_action ---

async function cmdTabAction({ action, tab_id, bypass_cache = false }) {
  if (!action) throw new Error('Missing required parameter: action');
  const tabId = await resolveTabId(tab_id);

  if (action === 'close') {
    await chrome.tabs.remove(tabId);
    return { action, closed: tabId };
  }
  if (action === 'activate') {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { action, activated: tabId };
  }

  const done = waitForComplete(tabId);
  if (action === 'reload') {
    await chrome.tabs.reload(tabId, { bypassCache: bypass_cache });
  } else if (action === 'back') {
    try { await chrome.tabs.goBack(tabId); }
    catch { throw new Error('Cannot go back: no previous history entry'); }
  } else if (action === 'forward') {
    try { await chrome.tabs.goForward(tabId); }
    catch { throw new Error('Cannot go forward: no next history entry'); }
  } else {
    throw new Error(`Unknown action: ${action}`);
  }
  await done;
  const t = await chrome.tabs.get(tabId);
  return { action, url: t.url, title: t.title, tabId };
}

// --- DevTools: get_page_info ---

async function cmdGetPageInfo({ tab_id, frame_id }) {
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: scriptTarget(tabId, frame_id),
    func: () => {
      const metas = [...document.querySelectorAll('meta')].map((m) => ({
        name: m.getAttribute('name') || m.getAttribute('property') || null,
        content: m.getAttribute('content') || null,
        charset: m.getAttribute('charset') || null,
        httpEquiv: m.getAttribute('http-equiv') || null,
      }));
      const scripts = [...document.querySelectorAll('script')].map((s) => ({
        src: s.src || null,
        type: s.type || null,
        async: s.async,
        defer: s.defer,
        inline: !s.src ? s.textContent.substring(0, 200) : null,
      }));
      const stylesheets = [...document.querySelectorAll('link[rel="stylesheet"], style')].map((s) => {
        if (s.tagName === 'LINK') return { type: 'link', href: s.href };
        return { type: 'inline', content: s.textContent.substring(0, 200) };
      });
      const links = [...document.querySelectorAll('a[href]')].slice(0, 100).map((a) => ({
        href: a.href,
        text: a.textContent.trim().substring(0, 100),
        target: a.target || null,
      }));
      const forms = [...document.querySelectorAll('form')].map((f) => ({
        action: f.action || null,
        method: f.method || 'get',
        id: f.id || null,
        fields: [...f.elements].slice(0, 50).map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.type || null,
          name: el.name || null,
          id: el.id || null,
        })),
      }));
      return {
        title: document.title,
        url: location.href,
        doctype: document.doctype ? document.doctype.name : null,
        charset: document.characterSet,
        metas,
        scripts,
        stylesheets,
        links,
        forms,
      };
    },
    world: 'MAIN',
  });
  return results?.[0]?.result ?? {};
}

// --- DevTools: get_storage ---

async function cmdGetStorage({ type = 'all', tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const data = {};

  if (type === 'all' || type === 'localStorage' || type === 'sessionStorage') {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (storageType) => {
        const out = {};
        if (storageType === 'all' || storageType === 'localStorage') {
          const ls = {};
          for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
          out.localStorage = ls;
        }
        if (storageType === 'all' || storageType === 'sessionStorage') {
          const ss = {};
          for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); ss[k] = sessionStorage.getItem(k); }
          out.sessionStorage = ss;
        }
        return out;
      },
      args: [type],
      world: 'MAIN',
    });
    Object.assign(data, results?.[0]?.result ?? {});
  }

  if (type === 'all' || type === 'cookies') {
    const tab = await chrome.tabs.get(tabId);
    const cookies = await chrome.cookies.getAll({ url: tab.url });
    data.cookies = cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
      session: c.session, expirationDate: c.expirationDate ?? null,
    }));
  }

  return data;
}

// --- DevTools: get_performance ---

async function cmdGetPerformance({ tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const nav = performance.getEntriesByType('navigation')[0];
      const paint = performance.getEntriesByType('paint');
      const lcp = performance.getEntriesByType('largest-contentful-paint');
      const resources = performance.getEntriesByType('resource').slice(0, 50).map((r) => ({
        name: r.name,
        type: r.initiatorType,
        duration: Math.round(r.duration),
        size: r.transferSize || 0,
      }));

      const timing = nav ? {
        dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
        tcp: Math.round(nav.connectEnd - nav.connectStart),
        ttfb: Math.round(nav.responseStart - nav.requestStart),
        download: Math.round(nav.responseEnd - nav.responseStart),
        domInteractive: Math.round(nav.domInteractive - nav.startTime),
        domComplete: Math.round(nav.domComplete - nav.startTime),
        loadEvent: Math.round(nav.loadEventEnd - nav.startTime),
      } : null;

      const paintMetrics = {};
      for (const p of paint) {
        paintMetrics[p.name] = Math.round(p.startTime);
      }
      if (lcp.length > 0) {
        paintMetrics['largest-contentful-paint'] = Math.round(lcp[lcp.length - 1].startTime);
      }

      const memory = performance.memory ? {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
      } : null;

      return { timing, paint: paintMetrics, memory, resources };
    },
    world: 'MAIN',
  });
  return results?.[0]?.result ?? {};
}

// --- DevTools: query_dom ---

async function cmdQueryDom({ selector, properties, limit = 50, tab_id, frame_id }) {
  if (!selector) throw new Error('Missing required parameter: selector');
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: scriptTarget(tabId, frame_id),
    func: (sel, props, lim) => {
      function deepQueryAll(sel) {
        if (!sel.includes('>>>')) return [...document.querySelectorAll(sel)];
        const parts = sel.split('>>>').map((s) => s.trim());
        const last = parts.pop();
        let ctx = document;
        for (const p of parts) {
          const found = ctx.querySelector(p);
          if (!found || !found.shadowRoot) return [];
          ctx = found.shadowRoot;
        }
        return [...ctx.querySelectorAll(last)];
      }
      const els = deepQueryAll(sel).slice(0, lim);
      return els.map((el) => {
        const attrs = {};
        for (const a of el.attributes) {
          attrs[a.name] = a.value;
        }
        const rect = el.getBoundingClientRect();
        const result = {
          tagName: el.tagName.toLowerCase(),
          id: el.id || null,
          className: el.className || null,
          attributes: attrs,
          textContent: el.textContent?.substring(0, 200)?.trim() || null,
          childCount: el.children.length,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
        if (props && props.length > 0) {
          const computed = getComputedStyle(el);
          result.computedStyles = {};
          for (const p of props) {
            result.computedStyles[p] = computed.getPropertyValue(p);
          }
        }
        return result;
      });
    },
    args: [selector, properties || null, limit],
    world: 'MAIN',
  });
  const elements = results?.[0]?.result ?? [];
  return { count: elements.length, elements };
}

// --- DevTools: modify_dom ---

async function cmdModifyDom({ selector, action, name, value, className, tab_id, frame_id }) {
  if (!selector) throw new Error('Missing required parameter: selector');
  if (!action) throw new Error('Missing required parameter: action');
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: scriptTarget(tabId, frame_id),
    func: (sel, act, attrName, attrValue, cls) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);
      switch (act) {
        case 'setAttribute':
          if (!attrName) throw new Error('Missing parameter: name');
          el.setAttribute(attrName, attrValue || '');
          break;
        case 'removeAttribute':
          if (!attrName) throw new Error('Missing parameter: name');
          el.removeAttribute(attrName);
          break;
        case 'addClass':
          if (!cls) throw new Error('Missing parameter: className');
          el.classList.add(cls);
          break;
        case 'removeClass':
          if (!cls) throw new Error('Missing parameter: className');
          el.classList.remove(cls);
          break;
        case 'setStyle':
          if (attrValue === undefined) throw new Error('Missing parameter: value');
          el.style.cssText = attrValue;
          break;
        case 'setTextContent':
          if (attrValue === undefined) throw new Error('Missing parameter: value');
          el.textContent = attrValue;
          break;
        default:
          throw new Error(`Unknown action: ${act}`);
      }
      return { success: true, tagName: el.tagName.toLowerCase(), action: act };
    },
    args: [selector, action, name || null, value || null, className || null],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { success: true };
}

// --- DevTools: inject_css ---

async function cmdInjectCss({ css, tab_id }) {
  if (!css) throw new Error('Missing required parameter: css');
  const tabId = await resolveTabId(tab_id);
  await chrome.scripting.insertCSS({
    target: { tabId },
    css,
  });
  return { success: true, injectedLength: css.length };
}

// --- DevTools: read_console ---
// Hook installed at document_start via console-capture.js content script (MAIN world).
// This function only reads the accumulated logs.

async function cmdReadConsole({ clear = false, level = 'all', tab_id }) {
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (shouldClear, filterLevel) => {
      const logs = window.__chromeBridge_consoleLogs || [];
      const filtered = filterLevel === 'all' ? logs : logs.filter((l) => l.level === filterLevel);
      if (shouldClear) {
        window.__chromeBridge_consoleLogs = [];
      }
      return filtered;
    },
    args: [clear, level],
    world: 'MAIN',
  });

  const messages = results?.[0]?.result ?? [];
  return { count: messages.length, messages };
}

// --- DevTools: monitor_network (stateful) ---

async function ensureNetworkHook(tabId) {
  if (injectedTabs.network.has(tabId)) return;

  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (window.__chromeBridge_networkHooked) return;
      window.__chromeBridge_networkHooked = true;
      window.__chromeBridge_networkRequests = [];
      window.__chromeBridge_inflight = 0;
      window.__chromeBridge_lastNetActivity = Date.now();
      const MAX = 1000;

      // --- Patch fetch ---
      const origFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const req = args[0];
        const url = typeof req === 'string' ? req : req?.url || String(req);
        const method = (args[1]?.method || (req?.method) || 'GET').toUpperCase();
        const entry = { type: 'fetch', method, url, startTime: Date.now(), status: null, duration: null, error: null };
        window.__chromeBridge_inflight += 1;
        window.__chromeBridge_lastNetActivity = Date.now();
        try {
          const resp = await origFetch(...args);
          entry.status = resp.status;
          entry.duration = Date.now() - entry.startTime;
          if (window.__chromeBridge_networkRequests.length < MAX) {
            window.__chromeBridge_networkRequests.push(entry);
          }
          window.__chromeBridge_inflight -= 1;
          window.__chromeBridge_lastNetActivity = Date.now();
          return resp;
        } catch (err) {
          entry.error = err.message;
          entry.duration = Date.now() - entry.startTime;
          if (window.__chromeBridge_networkRequests.length < MAX) {
            window.__chromeBridge_networkRequests.push(entry);
          }
          window.__chromeBridge_inflight -= 1;
          window.__chromeBridge_lastNetActivity = Date.now();
          throw err;
        }
      };

      // --- Patch XMLHttpRequest ---
      const OrigXHR = window.XMLHttpRequest;
      const origOpen = OrigXHR.prototype.open;
      const origSend = OrigXHR.prototype.send;
      OrigXHR.prototype.open = function (method, url, ...rest) {
        this.__cb_method = method;
        this.__cb_url = url;
        return origOpen.call(this, method, url, ...rest);
      };
      OrigXHR.prototype.send = function (...args) {
        const entry = { type: 'xhr', method: (this.__cb_method || 'GET').toUpperCase(), url: this.__cb_url || '', startTime: Date.now(), status: null, duration: null, error: null };
        this.addEventListener('load', () => {
          entry.status = this.status;
          entry.duration = Date.now() - entry.startTime;
          if (window.__chromeBridge_networkRequests.length < MAX) {
            window.__chromeBridge_networkRequests.push(entry);
          }
        });
        this.addEventListener('error', () => {
          entry.error = 'Network error';
          entry.duration = Date.now() - entry.startTime;
          if (window.__chromeBridge_networkRequests.length < MAX) {
            window.__chromeBridge_networkRequests.push(entry);
          }
        });
        // loadend copre load, error e abort: traccia sempre la fine dell'in-flight
        this.addEventListener('loadend', () => {
          window.__chromeBridge_inflight -= 1;
          window.__chromeBridge_lastNetActivity = Date.now();
        });
        window.__chromeBridge_inflight += 1;
        window.__chromeBridge_lastNetActivity = Date.now();
        return origSend.apply(this, args);
      };
    },
    world: 'MAIN',
  });
  injectedTabs.network.add(tabId);
}

async function cmdMonitorNetwork({ clear = false, source = 'page', tab_id }) {
  const tabId = await resolveTabId(tab_id);

  if (source === 'browser') {
    const requests = browserNetLog.get(tabId) ?? [];
    if (clear) browserNetLog.set(tabId, []);
    return { count: requests.length, requests: [...requests] };
  }

  await ensureNetworkHook(tabId);

  // Leggi le richieste
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (shouldClear) => {
      const requests = window.__chromeBridge_networkRequests || [];
      if (shouldClear) {
        window.__chromeBridge_networkRequests = [];
      }
      return requests;
    },
    args: [clear],
    world: 'MAIN',
  });

  const requests = results?.[0]?.result ?? [];
  return { count: requests.length, requests };
}

// --- wait_for_element ---

async function cmdWaitForElement({ selector, timeout = 10000, interval = 200, visible = false, tab_id, frame_id }) {
  if (!selector) throw new Error('Missing required parameter: selector');
  const tabId = await resolveTabId(tab_id);
  const clampedInterval = Math.max(interval, 50);

  const results = await chrome.scripting.executeScript({
    target: scriptTarget(tabId, frame_id),
    func: (sel, tout, intv, vis) => {
      function deepQuery(sel) {
        if (!sel.includes('>>>')) return document.querySelector(sel);
        const parts = sel.split('>>>').map((s) => s.trim());
        let ctx = document;
        for (let i = 0; i < parts.length; i++) {
          const found = ctx.querySelector(parts[i]);
          if (!found) return null;
          if (i === parts.length - 1) return found;
          if (!found.shadowRoot) return null;
          ctx = found.shadowRoot;
        }
        return null;
      }
      return new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
          const el = deepQuery(sel);
          if (el) {
            if (vis) {
              const style = getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                if (Date.now() - start >= tout) {
                  resolve({ found: false, error: 'Element found but not visible within timeout' });
                  return;
                }
                setTimeout(check, intv);
                return;
              }
            }
            const rect = el.getBoundingClientRect();
            resolve({
              found: true,
              tagName: el.tagName.toLowerCase(),
              elapsed: Date.now() - start,
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            });
            return;
          }
          if (Date.now() - start >= tout) {
            resolve({ found: false, error: `Element not found within ${tout}ms: ${sel}` });
            return;
          }
          setTimeout(check, intv);
        };
        check();
      });
    },
    args: [selector, timeout, clampedInterval, visible],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { found: false, error: 'No result' };
}

// --- scroll_to ---

async function cmdScrollTo({ selector, x, y, behavior = 'auto', offset_y = 0, tab_id, frame_id }) {
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: scriptTarget(tabId, frame_id),
    func: (sel, sx, sy, beh, offY) => {
      if (sel) {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`Element not found: ${sel}`);
        const rect = el.getBoundingClientRect();
        const targetY = rect.top + window.scrollY - offY;
        window.scrollTo({ top: targetY, left: rect.left + window.scrollX, behavior: beh });
      } else if (sx !== undefined || sy !== undefined) {
        window.scrollTo({ top: sy ?? window.scrollY, left: sx ?? window.scrollX, behavior: beh });
      } else {
        window.scrollTo({ top: 0, left: 0, behavior: beh });
      }
      return {
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    },
    args: [selector || null, x ?? null, y ?? null, behavior, offset_y],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? {};
}

// --- set_storage ---

async function cmdSetStorage({ type, action, key, value, path, domain, expires, secure, sameSite, http_only, tab_id }) {
  if (!type) throw new Error('Missing required parameter: type');
  if (!action) throw new Error('Missing required parameter: action');
  const tabId = await resolveTabId(tab_id);

  if (type === 'cookie') {
    const tab = await chrome.tabs.get(tabId);
    const sameSiteMap = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' };
    if (action === 'set') {
      if (!key) throw new Error('key is required for set action');
      const details = { url: tab.url, name: key, value: value || '', path: path || '/' };
      if (domain) details.domain = domain;
      if (expires) { const ts = Math.floor(new Date(expires).getTime() / 1000); if (Number.isNaN(ts)) throw new Error(`Invalid expires date: ${expires}`); details.expirationDate = ts; }
      if (secure || sameSite === 'None') details.secure = true;
      if (sameSite) details.sameSite = sameSiteMap[sameSite];
      if (http_only) details.httpOnly = true;
      await chrome.cookies.set(details);
      return { success: true, type: 'cookie', action: 'set', key };
    }
    if (action === 'delete') {
      if (!key) throw new Error('key is required for delete action');
      const matches = (await chrome.cookies.getAll({ url: tab.url })).filter((c) => c.name === key);
      for (const c of matches) {
        const cookieUrl = (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + c.path;
        await chrome.cookies.remove({ url: cookieUrl, name: c.name });
      }
      return { success: true, type: 'cookie', action: 'delete', key, removed: matches.length };
    }
    if (action === 'clear') {
      const cookies = await chrome.cookies.getAll({ url: tab.url });
      for (const c of cookies) {
        const cookieUrl = (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + c.path;
        await chrome.cookies.remove({ url: cookieUrl, name: c.name });
      }
      return { success: true, type: 'cookie', action: 'clear', cleared: cookies.length };
    }
    throw new Error(`Invalid cookie action: ${action}`);
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sType, sAction, sKey, sValue) => {
      const storage = sType === 'localStorage' ? localStorage : sessionStorage;
      if (sAction === 'set') {
        if (!sKey) throw new Error('key is required for set action');
        storage.setItem(sKey, sValue || '');
        return { success: true, type: sType, action: 'set', key: sKey };
      } else if (sAction === 'delete') {
        if (!sKey) throw new Error('key is required for delete action');
        storage.removeItem(sKey);
        return { success: true, type: sType, action: 'delete', key: sKey };
      } else if (sAction === 'clear') {
        storage.clear();
        return { success: true, type: sType, action: 'clear' };
      }
      throw new Error(`Invalid action: ${sAction}`);
    },
    args: [type, action, key || null, value || null],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { success: false };
}

// --- fill_form ---

async function cmdFillForm({ fields, submit_selector, tab_id, frame_id }) {
  if (!fields || !Array.isArray(fields)) throw new Error('Missing required parameter: fields');
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: scriptTarget(tabId, frame_id),
    func: (flds, submitSel) => {
      const report = [];
      for (const { selector, value } of flds) {
        try {
          const el = document.querySelector(selector);
          if (!el) { report.push({ selector, success: false, error: 'Element not found' }); continue; }
          const tag = el.tagName.toLowerCase();
          const type = (el.type || '').toLowerCase();
          const disabled = el.disabled;
          const readOnly = el.readOnly;

          if (disabled || readOnly) {
            report.push({ selector, success: true, tagName: tag, type, warning: disabled ? 'disabled' : 'readonly' });
            continue;
          }

          if (tag === 'select') {
            // Try match by value first, then by text
            let found = false;
            for (const opt of el.options) {
              if (opt.value === value || opt.textContent.trim() === value) {
                el.value = opt.value;
                found = true;
                break;
              }
            }
            if (!found) { report.push({ selector, success: false, tagName: tag, type: 'select', error: `Option not found: ${value}` }); continue; }
          } else if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
            const shouldCheck = value === 'true' || value === '1';
            if (el.checked !== shouldCheck) el.click();
          } else if (tag === 'textarea' || tag === 'input') {
            // React-compatible value setting
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value'
            )?.set;
            if (nativeInputValueSetter) {
              nativeInputValueSetter.call(el, value);
            } else {
              el.value = value;
            }
          } else {
            el.value = value;
          }

          el.dispatchEvent(new Event('focus', { bubbles: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          report.push({ selector, success: true, tagName: tag, type: type || tag });
        } catch (e) {
          report.push({ selector, success: false, error: e.message });
        }
      }

      if (submitSel) {
        const btn = document.querySelector(submitSel);
        if (btn) btn.click();
      }

      return report;
    },
    args: [fields, submit_selector || null],
    world: 'MAIN',
  });
  return { fields: results?.[0]?.result ?? [] };
}

// --- viewport_resize ---

async function cmdViewportResize({ preset, width, height, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const tab = await chrome.tabs.get(tabId);

  const presets = { mobile: { w: 375, h: 812 }, tablet: { w: 768, h: 1024 }, desktop: { w: 1440, h: 900 } };
  let targetW = width;
  let targetH = height;

  if (preset && presets[preset]) {
    if (!targetW) targetW = presets[preset].w;
    if (!targetH) targetH = presets[preset].h;
  }

  const updateOpts = {};
  if (targetW) updateOpts.width = targetW;
  if (targetH) updateOpts.height = targetH;

  if (Object.keys(updateOpts).length === 0) throw new Error('Provide preset, width, or height');

  await chrome.windows.update(tab.windowId, updateOpts);
  await new Promise((r) => setTimeout(r, 200));

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    }),
    world: 'MAIN',
  });
  const actual = results?.[0]?.result ?? {};
  return { requested: { width: targetW, height: targetH, preset: preset || null }, actual };
}

// --- full_page_screenshot ---

async function cmdFullPageScreenshot({ max_scrolls = 20, delay = 500, stitch = true, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  // Chrome quota: max 2 captureVisibleTab al secondo — clamp a 500ms
  const safeDelay = Math.max(delay, 500);

  // Get page dimensions
  const dimResults = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      originalScrollY: window.scrollY,
    }),
    world: 'MAIN',
  });
  const { scrollHeight, viewportHeight, viewportWidth, originalScrollY } = dimResults?.[0]?.result ?? {};
  const steps = Math.min(Math.ceil(scrollHeight / viewportHeight), max_scrolls);
  const shots = [];

  for (let i = 0; i < steps; i++) {
    const target = Math.min(i * viewportHeight, Math.max(0, scrollHeight - viewportHeight));
    const sRes = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sy) => { window.scrollTo(0, sy); return window.scrollY; },
      args: [target],
      world: 'MAIN',
    });
    const actualY = sRes?.[0]?.result ?? target;
    await new Promise((r) => setTimeout(r, safeDelay));
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    shots.push({ dataUrl, y: actualY });
    if (actualY + viewportHeight >= scrollHeight) break;
  }

  // Restore scroll position
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (sy) => window.scrollTo(0, sy),
    args: [originalScrollY],
    world: 'MAIN',
  });

  if (!shots.length) throw new Error('No captures (page dimensions unavailable)');

  if (!stitch) {
    return {
      captures: shots.map((s) => s.dataUrl.replace(/^data:image\/png;base64,/, '')),
      scrollHeight, viewportHeight, totalCaptures: shots.length,
    };
  }

  // Stitching su OffscreenCanvas (limite hard Chrome ~16384px per lato)
  const MAX_CANVAS_H = 16384;
  const first = await dataUrlToBitmap(shots[0].dataUrl);
  const dpr = first.width / viewportWidth;
  const fullH = Math.min(Math.round(scrollHeight * dpr), MAX_CANVAS_H);
  const canvas = new OffscreenCanvas(first.width, fullH);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(first, 0, Math.round(shots[0].y * dpr));
  for (let i = 1; i < shots.length; i++) {
    const bmp = await dataUrlToBitmap(shots[i].dataUrl);
    ctx.drawImage(bmp, 0, Math.round(shots[i].y * dpr));
  }
  return {
    image: await canvasToBase64(canvas),
    stitched: true,
    scrollHeight, viewportHeight, totalCaptures: shots.length,
    truncated: scrollHeight * dpr > MAX_CANVAS_H,
  };
}

// --- element_screenshot ---

async function cmdElementScreenshot({ selector, tab_id }) {
  if (!selector) throw new Error('Missing required parameter: selector');
  const tabId = await resolveTabId(tab_id);
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });

  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);
      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: window.devicePixelRatio };
    },
    args: [selector],
    world: 'MAIN',
  });
  const rect = res?.[0]?.result;
  if (!rect || rect.width === 0 || rect.height === 0) throw new Error('Element has no visible area');

  // Delay per rendering post-scroll (behavior:'instant' forzato per evitare smooth-scroll CSS)
  await new Promise((r) => setTimeout(r, 300));
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const bitmap = await dataUrlToBitmap(dataUrl);
  const { dpr } = rect;
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.min(Math.round(rect.width * dpr), bitmap.width - sx);
  const sh = Math.min(Math.round(rect.height * dpr), bitmap.height - sy);
  if (sw <= 0 || sh <= 0) throw new Error('Element is outside the visible viewport');
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  return { image: await canvasToBase64(canvas), width: sw, height: sh };
}

// --- highlight_elements ---

async function cmdHighlightElements({ selector, color = 'rgba(255,0,0,0.3)', border = '2px solid red', label = false, remove = false, tab_id }) {
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, bg, brd, showLabel, doRemove) => {
      // Remove existing highlights
      const existing = document.querySelectorAll('[data-chrome-bridge-highlight]');
      existing.forEach((el) => el.remove());

      if (doRemove || !sel) {
        return { removed: existing.length, highlighted: 0 };
      }

      const els = [...document.querySelectorAll(sel)].slice(0, 100);
      let count = 0;
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const overlay = document.createElement('div');
        overlay.setAttribute('data-chrome-bridge-highlight', 'true');
        overlay.style.cssText = `position:absolute;top:${rect.top+window.scrollY}px;left:${rect.left+window.scrollX}px;width:${rect.width}px;height:${rect.height}px;background:${bg};border:${brd};pointer-events:none;z-index:2147483647;box-sizing:border-box;`;
        if (showLabel) {
          const tag = el.tagName.toLowerCase();
          const cls = el.className ? `.${el.className.toString().split(' ')[0]}` : '';
          overlay.textContent = `${tag}${cls} (${Math.round(rect.width)}x${Math.round(rect.height)})`;
          overlay.style.fontSize = '10px';
          overlay.style.color = '#fff';
          overlay.style.textShadow = '0 0 2px #000';
          overlay.style.overflow = 'hidden';
          overlay.style.padding = '1px 3px';
        }
        document.body.appendChild(overlay);
        count++;
      }
      return { removed: existing.length, highlighted: count };
    },
    args: [selector || null, color, border, label, remove],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { highlighted: 0 };
}

// --- accessibility_audit ---

async function cmdAccessibilityAudit({ scope, checks = ['all'], tab_id }) {
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (scopeSel, checkList) => {
      const root = scopeSel ? document.querySelector(scopeSel) : document.body;
      if (!root) return { summary: { total: 0, errors: 0, warnings: 0 }, violations: [], warning: 'Scope element not found' };

      const runAll = checkList.includes('all');
      const violations = [];
      const CAP = 500;

      function selectorFor(el) {
        if (el.id) return `#${el.id}`;
        const tag = el.tagName.toLowerCase();
        const cls = el.className ? `.${el.className.toString().trim().split(/\s+/).join('.')}` : '';
        return `${tag}${cls}`;
      }

      // Images
      if (runAll || checkList.includes('images')) {
        const imgs = [...root.querySelectorAll('img')].slice(0, CAP);
        for (const img of imgs) {
          if (!img.alt && img.alt !== '') {
            violations.push({ type: 'images', severity: 'error', selector: selectorFor(img), message: 'Image missing alt attribute' });
          } else if (img.alt === '') {
            violations.push({ type: 'images', severity: 'warning', selector: selectorFor(img), message: 'Image has empty alt (decorative?)' });
          }
        }
        const svgs = [...root.querySelectorAll('svg')].slice(0, CAP);
        for (const svg of svgs) {
          if (!svg.getAttribute('aria-label') && !svg.getAttribute('aria-labelledby') && !svg.querySelector('title')) {
            violations.push({ type: 'images', severity: 'warning', selector: selectorFor(svg), message: 'SVG missing accessible name' });
          }
        }
      }

      // Links
      if (runAll || checkList.includes('links')) {
        const links = [...root.querySelectorAll('a')].slice(0, CAP);
        for (const a of links) {
          const text = a.textContent.trim();
          const label = a.getAttribute('aria-label');
          if (!text && !label && !a.querySelector('img[alt]')) {
            violations.push({ type: 'links', severity: 'error', selector: selectorFor(a), message: 'Empty link without accessible name' });
          }
        }
      }

      // Headings
      if (runAll || checkList.includes('headings')) {
        const headings = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')];
        let prevLevel = 0;
        for (const h of headings) {
          const level = parseInt(h.tagName[1]);
          if (prevLevel > 0 && level > prevLevel + 1) {
            violations.push({ type: 'headings', severity: 'warning', selector: selectorFor(h), message: `Heading skip: h${prevLevel} → h${level}` });
          }
          prevLevel = level;
        }
      }

      // ARIA
      if (runAll || checkList.includes('aria')) {
        const ariaHidden = [...root.querySelectorAll('[aria-hidden="true"]')].slice(0, CAP);
        for (const el of ariaHidden) {
          if (el.matches('a[href], button, input, select, textarea, [tabindex]') || el.querySelector('a[href], button, input, select, textarea, [tabindex]')) {
            violations.push({ type: 'aria', severity: 'error', selector: selectorFor(el), message: 'aria-hidden on focusable element' });
          }
        }
      }

      // Contrast (WCAG 2.1 ratio)
      if (runAll || checkList.includes('contrast')) {
        const parseColor = (c) => {
          const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
          if (!m) return null;
          return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
        };
        const luminance = ({ r, g, b }) => {
          const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const effectiveBg = (el) => {
          let node = el;
          while (node && node !== document.documentElement) {
            const bg = parseColor(getComputedStyle(node).backgroundColor);
            if (bg && bg.a >= 0.99) return bg;
            node = node.parentElement;
          }
          return { r: 255, g: 255, b: 255, a: 1 };
        };
        const textEls = [...root.querySelectorAll('p, span, a, li, td, th, label, h1, h2, h3, h4, h5, h6, button')].slice(0, 200);
        for (const el of textEls) {
          if (!el.textContent.trim()) continue;
          const style = getComputedStyle(el);
          const fg = parseColor(style.color);
          if (!fg) continue;
          const bg = effectiveBg(el);
          const L1 = Math.max(luminance(fg), luminance(bg));
          const L2 = Math.min(luminance(fg), luminance(bg));
          const ratio = (L1 + 0.05) / (L2 + 0.05);
          const px = parseFloat(style.fontSize);
          const bold = parseInt(style.fontWeight) >= 700;
          const isLarge = px >= 24 || (px >= 18.66 && bold);
          const required = isLarge ? 3 : 4.5;
          if (ratio < required) {
            violations.push({
              type: 'contrast',
              severity: ratio < required - 1.5 ? 'error' : 'warning',
              selector: selectorFor(el),
              message: `Contrast ${ratio.toFixed(2)}:1 below WCAG ${required}:1 (${isLarge ? 'large' : 'normal'} text)`,
            });
          }
        }
      }

      // Forms
      if (runAll || checkList.includes('forms')) {
        const inputs = [...root.querySelectorAll('input, select, textarea')].slice(0, CAP);
        for (const input of inputs) {
          if (input.type === 'hidden' || input.type === 'submit' || input.type === 'button') continue;
          const id = input.id;
          const hasLabel = id && root.querySelector(`label[for="${id}"]`);
          const wrappedLabel = input.closest('label');
          const ariaLabel = input.getAttribute('aria-label') || input.getAttribute('aria-labelledby');
          if (!hasLabel && !wrappedLabel && !ariaLabel) {
            violations.push({ type: 'forms', severity: 'error', selector: selectorFor(input), message: 'Form input without associated label' });
          }
        }
      }

      const errors = violations.filter((v) => v.severity === 'error').length;
      const warnings = violations.filter((v) => v.severity === 'warning').length;
      return { summary: { total: violations.length, errors, warnings }, violations };
    },
    args: [scope || null, checks],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { summary: { total: 0, errors: 0, warnings: 0 }, violations: [] };
}

// --- collect_links ---

async function cmdCollectLinks({ scope = 'all', selector = 'a[href]', max_links = 50, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, linkScope, maxLinks) => {
      const origin = location.origin;
      const skipPatterns = /^(javascript:|mailto:|tel:|#|data:)/i;
      const anchors = [...document.querySelectorAll(sel)].slice(0, 500);
      const seen = new Set();
      const links = [];
      for (const a of anchors) {
        const href = a.href;
        if (!href || skipPatterns.test(href) || seen.has(href)) continue;
        seen.add(href);
        try {
          const url = new URL(href);
          const isSameOrigin = url.origin === origin;
          if (linkScope === 'same-origin' && !isSameOrigin) continue;
          if (linkScope === 'external' && isSameOrigin) continue;
          links.push({ url: href, text: a.textContent.trim().substring(0, 100) });
        } catch { continue; }
        if (links.length >= maxLinks) break;
      }
      return { links, totalAnchors: anchors.length };
    },
    args: [selector, scope, max_links],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { links: [], totalAnchors: 0 };
}

// --- measure_spacing ---

async function cmdMeasureSpacing({ selector1, selector2, tab_id }) {
  if (!selector1 || !selector2) throw new Error('Missing required parameters: selector1, selector2');
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel1, sel2) => {
      const el1 = document.querySelector(sel1);
      const el2 = document.querySelector(sel2);
      if (!el1) throw new Error(`Element not found: ${sel1}`);
      if (!el2) throw new Error(`Element not found: ${sel2}`);

      function getInfo(el, sel) {
        const rect = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          selector: sel,
          tagName: el.tagName.toLowerCase(),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          margin: { top: parseFloat(cs.marginTop), right: parseFloat(cs.marginRight), bottom: parseFloat(cs.marginBottom), left: parseFloat(cs.marginLeft) },
          padding: { top: parseFloat(cs.paddingTop), right: parseFloat(cs.paddingRight), bottom: parseFloat(cs.paddingBottom), left: parseFloat(cs.paddingLeft) },
          hidden: rect.width === 0 && rect.height === 0,
        };
      }

      const info1 = getInfo(el1, sel1);
      const info2 = getInfo(el2, sel2);
      const r1 = el1.getBoundingClientRect();
      const r2 = el2.getBoundingClientRect();

      const horizontalGap = Math.max(0, Math.max(r2.left - r1.right, r1.left - r2.right));
      const verticalGap = Math.max(0, Math.max(r2.top - r1.bottom, r1.top - r2.bottom));
      const overlapX = Math.max(0, Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left));
      const overlapY = Math.max(0, Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top));
      const center1 = { x: r1.left + r1.width / 2, y: r1.top + r1.height / 2 };
      const center2 = { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2 };
      const centerDistance = Math.round(Math.sqrt((center2.x - center1.x) ** 2 + (center2.y - center1.y) ** 2));

      return {
        element1: info1,
        element2: info2,
        spacing: {
          horizontalGap: Math.round(horizontalGap),
          verticalGap: Math.round(verticalGap),
          overlap: overlapX > 0 && overlapY > 0,
          overlapArea: overlapX > 0 && overlapY > 0 ? { width: Math.round(overlapX), height: Math.round(overlapY) } : null,
          centerDistance,
        },
      };
    },
    args: [selector1, selector2],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? {};
}

// --- watch_dom (stateful) ---

async function cmdWatchDom({ selector = 'body', attributes = true, childList = true, characterData = false, subtree = true, clear = false, stop = false, tab_id }) {
  const tabId = await resolveTabId(tab_id);

  if (stop) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (window.__chromeBridge_domObserver) {
          window.__chromeBridge_domObserver.disconnect();
          window.__chromeBridge_domObserver = null;
        }
        window.__chromeBridge_domWatcherHooked = false;
        window.__chromeBridge_domMutations = [];
      },
      world: 'MAIN',
    });
    return { stopped: true, count: 0, mutations: [] };
  }

  // Always inject: idempotent via in-page guard; handles selector change by re-observing.
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, opts) => {
      if (window.__chromeBridge_domWatcherHooked && window.__chromeBridge_domWatchSelector !== sel) {
        if (window.__chromeBridge_domObserver) window.__chromeBridge_domObserver.disconnect();
        window.__chromeBridge_domWatcherHooked = false;
        window.__chromeBridge_domMutations = [];
      }
      if (window.__chromeBridge_domWatcherHooked) return;
      window.__chromeBridge_domWatcherHooked = true;
      window.__chromeBridge_domWatchSelector = sel;
      window.__chromeBridge_domMutations = [];
      const MAX = 1000;
      const target = document.querySelector(sel) || document.body;
      const observer = new MutationObserver((mutationList) => {
        for (const m of mutationList) {
          if (window.__chromeBridge_domMutations.length >= MAX) break;
          const entry = {
            type: m.type,
            target: m.target.tagName ? m.target.tagName.toLowerCase() : '#text',
            timestamp: Date.now(),
          };
          if (m.type === 'attributes') entry.attributeName = m.attributeName;
          if (m.type === 'childList') {
            entry.addedNodes = m.addedNodes.length;
            entry.removedNodes = m.removedNodes.length;
          }
          // Skip our own highlight overlays
          if (m.target.hasAttribute && m.target.hasAttribute('data-chrome-bridge-highlight')) continue;
          window.__chromeBridge_domMutations.push(entry);
        }
      });
      observer.observe(target, opts);
      window.__chromeBridge_domObserver = observer;
    },
    args: [selector, { attributes, childList, characterData, subtree }],
    world: 'MAIN',
  });

  // Read mutations
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (shouldClear) => {
      const mutations = window.__chromeBridge_domMutations || [];
      if (shouldClear) window.__chromeBridge_domMutations = [];
      return mutations;
    },
    args: [clear],
    world: 'MAIN',
  });
  const mutations = results?.[0]?.result ?? [];
  return { count: mutations.length, mutations };
}

// --- emulate_media ---

async function cmdEmulateMedia({ colorScheme, reducedMotion, printMode = false, reset = false, tab_id }) {
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (cs, rm, print, doReset) => {
      const STYLE_ID = '__chromeBridge_media';
      const META_ID = '__chromeBridge_colorScheme';

      if (doReset) {
        const style = document.getElementById(STYLE_ID);
        if (style) style.remove();
        const meta = document.getElementById(META_ID);
        if (meta) meta.remove();
        // Restore original matchMedia if saved
        if (window.__chromeBridge_origMatchMedia) {
          window.matchMedia = window.__chromeBridge_origMatchMedia;
          delete window.__chromeBridge_origMatchMedia;
        }
        return { reset: true };
      }

      // Save original matchMedia
      if (!window.__chromeBridge_origMatchMedia) {
        window.__chromeBridge_origMatchMedia = window.matchMedia.bind(window);
      }

      const overrides = {};
      if (cs) overrides['prefers-color-scheme'] = cs;
      if (rm) overrides['prefers-reduced-motion'] = rm;
      if (print) overrides['print'] = true;

      // Override matchMedia for JS-based checks.
      // NB: spreading a MediaQueryList loses prototype methods (addEventListener ecc.),
      // quindi per le query forzate restituiamo uno stub MQL-compatibile.
      const orig = window.__chromeBridge_origMatchMedia;
      const mkStub = (matches, query) => ({
        matches,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() { return false; },
      });
      window.matchMedia = (query) => {
        for (const [feature, val] of Object.entries(overrides)) {
          if (feature === 'print' && query.includes('print')) return mkStub(true, query);
          if (query.includes(feature) && query.includes(val)) return mkStub(true, query);
          if (query.includes(feature) && !query.includes(val)) return mkStub(false, query);
        }
        return orig(query);
      };

      // Inject CSS + meta for CSS-based checks
      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        document.head.appendChild(style);
      }

      let css = '';
      if (cs === 'dark') css += ':root { color-scheme: dark; }\n';
      else if (cs === 'light') css += ':root { color-scheme: light; }\n';
      if (rm === 'reduce') css += '*, *::before, *::after { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }\n';
      if (print) css += '@media screen { body { } }\n'; // placeholder, actual print emulation via matchMedia override
      style.textContent = css;

      // Color scheme meta tag
      let meta = document.getElementById(META_ID);
      if (cs) {
        if (!meta) {
          meta = document.createElement('meta');
          meta.id = META_ID;
          meta.name = 'color-scheme';
          document.head.appendChild(meta);
        }
        meta.content = cs === 'dark' ? 'dark' : cs === 'light' ? 'light' : 'light dark';
      } else if (meta) {
        meta.remove();
      }

      return { emulated: overrides };
    },
    args: [colorScheme || null, reducedMotion || null, printMode, reset],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? {};
}

// --- hover ---

async function cmdHover({ selector, tab_id, frame_id }) {
  if (!selector) throw new Error('Missing required parameter: selector');
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: scriptTarget(tabId, frame_id),
    func: (sel) => {
      function deepQuery(sel) {
        if (!sel.includes('>>>')) return document.querySelector(sel);
        const parts = sel.split('>>>').map((s) => s.trim());
        let ctx = document;
        for (let i = 0; i < parts.length; i++) {
          const found = ctx.querySelector(parts[i]);
          if (!found) return null;
          if (i === parts.length - 1) return found;
          if (!found.shadowRoot) return null;
          ctx = found.shadowRoot;
        }
        return null;
      }
      const el = deepQuery(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
      el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      el.dispatchEvent(new MouseEvent('mousemove', opts));
      return {
        tagName: el.tagName.toLowerCase(),
        text: el.textContent?.substring(0, 100)?.trim() || null,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    },
    args: [selector],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { hovered: true };
}

// --- press_key ---

async function cmdPressKey({ key, selector, ctrl = false, shift = false, alt = false, meta = false, tab_id, frame_id }) {
  if (!key) throw new Error('Missing required parameter: key');
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: scriptTarget(tabId, frame_id),
    func: (k, sel, mods) => {
      function deepQuery(sel) {
        if (!sel.includes('>>>')) return document.querySelector(sel);
        const parts = sel.split('>>>').map((s) => s.trim());
        let ctx = document;
        for (let i = 0; i < parts.length; i++) {
          const found = ctx.querySelector(parts[i]);
          if (!found) return null;
          if (i === parts.length - 1) return found;
          if (!found.shadowRoot) return null;
          ctx = found.shadowRoot;
        }
        return null;
      }
      let el;
      if (sel) {
        el = deepQuery(sel);
        if (!el) throw new Error(`Element not found: ${sel}`);
      } else {
        el = document.activeElement || document.body;
      }
      const keyToCode = (kk) => {
        if (/^[a-z]$/i.test(kk)) return `Key${kk.toUpperCase()}`;
        if (/^[0-9]$/.test(kk)) return `Digit${kk}`;
        const map = {
          ' ': 'Space', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
          '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period',
          '/': 'Slash', '`': 'Backquote',
        };
        return map[kk] || kk;
      };
      const opts = {
        key: k,
        code: keyToCode(k),
        bubbles: true,
        cancelable: true,
        ctrlKey: mods.ctrl,
        shiftKey: mods.shift,
        altKey: mods.alt,
        metaKey: mods.meta,
      };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      // keypress only for printable chars
      if (k.length === 1) {
        el.dispatchEvent(new KeyboardEvent('keypress', opts));
      }
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      return {
        key: k,
        target: el.tagName.toLowerCase(),
        modifiers: Object.entries(mods).filter(([, v]) => v).map(([m]) => m),
      };
    },
    args: [key, selector || null, { ctrl, shift, alt, meta }],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { pressed: true };
}

// --- get_frames ---

async function cmdGetFrames({ tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  return {
    frames: (frames || []).map((f) => ({
      frameId: f.frameId,
      parentFrameId: f.parentFrameId,
      url: f.url,
    })),
  };
}

// --- upload_file ---

async function cmdUploadFile({ selector, name, mime_type, content_b64, tab_id }) {
  if (!selector) throw new Error('Missing required parameter: selector');
  if (!content_b64) throw new Error('Missing required parameter: content_b64');
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, fname, mime, b64) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') throw new Error('Element is not an input[type=file]');
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], fname, { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { uploaded: fname, size: bytes.length, mime };
    },
    args: [selector, name, mime_type, content_b64],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { uploaded: false };
}

// --- wait_for_navigation ---

async function cmdWaitForNavigation({ timeout = 15000, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const start = Date.now();
  const tab = await chrome.tabs.get(tabId);

  if (tab.status === 'complete') {
    // Attendi che una navigazione parta (entro min(timeout, 5s))
    const started = await new Promise((resolve) => {
      const listener = (id, info) => {
        if (id === tabId && info.status === 'loading') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(true);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(false); }, Math.min(timeout, 5000));
    });
    if (!started) {
      const t = await chrome.tabs.get(tabId);
      return { navigated: false, url: t.url, note: 'No navigation started' };
    }
  }

  const completed = await waitForComplete(tabId, Math.max(0, timeout - (Date.now() - start)));
  const t = await chrome.tabs.get(tabId);
  return { navigated: completed, url: t.url, title: t.title, elapsed: Date.now() - start };
}

// --- wait_for_network_idle ---

async function cmdWaitForNetworkIdle({ idle_ms = 500, timeout = 15000, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  await ensureNetworkHook(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (idleMs, tout) => new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const inflight = window.__chromeBridge_inflight || 0;
        const last = window.__chromeBridge_lastNetActivity || start;
        if (inflight === 0 && Date.now() - last >= idleMs) {
          resolve({ idle: true, elapsed: Date.now() - start });
          return;
        }
        if (Date.now() - start >= tout) {
          resolve({ idle: false, inflight, elapsed: Date.now() - start });
          return;
        }
        setTimeout(check, 100);
      };
      check();
    }),
    args: [idle_ms, timeout],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { idle: false };
}

// --- handle_dialogs ---

async function cmdHandleDialogs({ action = 'accept', prompt_text, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (act, promptText) => {
      if (act === 'reset') {
        if (window.__chromeBridge_origDialogs) {
          window.alert = window.__chromeBridge_origDialogs.alert;
          window.confirm = window.__chromeBridge_origDialogs.confirm;
          window.prompt = window.__chromeBridge_origDialogs.prompt;
          delete window.__chromeBridge_origDialogs;
        }
        const log = window.__chromeBridge_dialogs || [];
        window.__chromeBridge_dialogs = [];
        return { reset: true, dialogs: log };
      }
      if (!window.__chromeBridge_origDialogs) {
        window.__chromeBridge_origDialogs = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
        window.__chromeBridge_dialogs = [];
      }
      window.__chromeBridge_dialogPolicy = { action: act, promptText: promptText ?? null };
      const push = (type, message) => {
        window.__chromeBridge_dialogs.push({ type, message: String(message ?? ''), timestamp: Date.now() });
        if (window.__chromeBridge_dialogs.length > 100) window.__chromeBridge_dialogs.shift();
      };
      window.alert = (msg) => { push('alert', msg); };
      window.confirm = (msg) => { push('confirm', msg); return window.__chromeBridge_dialogPolicy.action === 'accept'; };
      window.prompt = (msg, def) => {
        push('prompt', msg);
        const p = window.__chromeBridge_dialogPolicy;
        return p.action === 'accept' ? (p.promptText ?? def ?? '') : null;
      };
      return { installed: true, policy: act, dialogs: window.__chromeBridge_dialogs };
    },
    args: [action, prompt_text ?? null],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? {};
}

// --- find_text ---

async function cmdFindText({ text, case_sensitive = false, max_results = 20, tab_id }) {
  if (!text) throw new Error('Missing required parameter: text');
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (needleRaw, caseSensitive, maxResults) => {
      const needle = caseSensitive ? needleRaw : needleRaw.toLowerCase();
      const matches = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
          const p = n.parentElement;
          if (!p || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const selectorFor = (el) => {
        if (el.id) return `#${el.id}`;
        const tag = el.tagName.toLowerCase();
        const cls = el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : '';
        return `${tag}${cls}`;
      };
      let node;
      while ((node = walker.nextNode()) && matches.length < maxResults) {
        const hay = caseSensitive ? node.textContent : node.textContent.toLowerCase();
        let idx = hay.indexOf(needle);
        while (idx !== -1 && matches.length < maxResults) {
          const parent = node.parentElement;
          const rect = parent.getBoundingClientRect();
          const ctx = node.textContent.substring(Math.max(0, idx - 40), idx + needleRaw.length + 40);
          matches.push({
            selector: selectorFor(parent),
            context: ctx.trim(),
            visible: rect.width > 0 && rect.height > 0,
            position: { x: Math.round(rect.x + window.scrollX), y: Math.round(rect.y + window.scrollY) },
          });
          idx = hay.indexOf(needle, idx + 1);
        }
      }
      return { count: matches.length, matches };
    },
    args: [text, case_sensitive, max_results],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { count: 0, matches: [] };
}

// --- network_rules (declarativeNetRequest) ---
// Nota: le regole dinamiche sono globali per il browser, non per-tab.

async function cmdNetworkRules({ action, url_filter, redirect_url, header, header_value, resource_types }) {
  if (!action) throw new Error('Missing required parameter: action');

  if (action === 'list') {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    return { count: rules.length, rules };
  }

  if (action === 'clear') {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: rules.map((r) => r.id),
    });
    return { cleared: rules.length };
  }

  if (!url_filter) throw new Error('Missing required parameter: url_filter');
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const nextId = existing.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const types = resource_types && resource_types.length > 0 ? resource_types : undefined;
  const condition = { urlFilter: url_filter };
  if (types) condition.resourceTypes = types;

  let rule;
  if (action === 'block') {
    rule = { id: nextId, priority: 1, action: { type: 'block' }, condition };
  } else if (action === 'redirect') {
    if (!redirect_url) throw new Error('Missing required parameter: redirect_url');
    rule = { id: nextId, priority: 1, action: { type: 'redirect', redirect: { url: redirect_url } }, condition };
  } else if (action === 'modify_header') {
    if (!header) throw new Error('Missing required parameter: header');
    const op = header_value === undefined || header_value === null || header_value === ''
      ? { header, operation: 'remove' }
      : { header, operation: 'set', value: header_value };
    rule = { id: nextId, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [op] }, condition };
  } else {
    throw new Error(`Unknown action: ${action}`);
  }

  await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
  return { added: rule };
}

// --- screenshot_diff (regressione visiva) ---
// Baseline in memoria del service worker: persa se il SW viene sospeso.
// NOTA: la logica capture+crop duplica cmdElementScreenshot — candidata a refactor futuro.

const MAX_DIFF_BASELINES = 10;
const diffBaselines = new Map(); // name → { bitmapData: ImageData, width, height, capturedAt, selector }

async function captureForDiff(tabId, selector) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });

  let cropRect = null;
  if (selector) {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`Element not found: ${sel}`);
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: window.devicePixelRatio };
      },
      args: [selector],
      world: 'MAIN',
    });
    cropRect = res?.[0]?.result;
    if (!cropRect || cropRect.width === 0 || cropRect.height === 0) throw new Error('Element has no visible area');
  }

  await new Promise((r) => setTimeout(r, 300));
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const bitmap = await dataUrlToBitmap(dataUrl);

  let sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height;
  if (cropRect) {
    const dpr = cropRect.dpr;
    sx = Math.max(0, Math.round(cropRect.x * dpr));
    sy = Math.max(0, Math.round(cropRect.y * dpr));
    sw = Math.min(Math.round(cropRect.width * dpr), bitmap.width - sx);
    sh = Math.min(Math.round(cropRect.height * dpr), bitmap.height - sy);
    if (sw <= 0 || sh <= 0) throw new Error('Element is outside the visible viewport');
  }

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  return { canvas, ctx, width: sw, height: sh };
}

async function cmdScreenshotDiff({ action, name = 'default', selector, threshold = 10, tab_id }) {
  if (!action) throw new Error('Missing required parameter: action');

  if (action === 'list') {
    return {
      baselines: [...diffBaselines.entries()].map(([n, b]) => ({
        name: n, width: b.width, height: b.height, capturedAt: b.capturedAt, selector: b.selector,
      })),
    };
  }

  if (action === 'clear') {
    const n = diffBaselines.size;
    diffBaselines.clear();
    return { cleared: n };
  }

  const tabId = await resolveTabId(tab_id);

  if (action === 'baseline') {
    if (!diffBaselines.has(name) && diffBaselines.size >= MAX_DIFF_BASELINES) {
      throw new Error(`Too many stored baselines (max ${MAX_DIFF_BASELINES}) — use action: clear to free memory`);
    }
    const { ctx, width, height } = await captureForDiff(tabId, selector);
    diffBaselines.set(name, {
      bitmapData: ctx.getImageData(0, 0, width, height),
      width, height,
      capturedAt: Date.now(),
      selector: selector || null,
    });
    return { baseline: name, width, height, selector: selector || null };
  }

  if (action === 'compare') {
    const base = diffBaselines.get(name);
    if (!base) throw new Error(`No baseline named "${name}" — capture one first with action: baseline (note: baselines are lost if the extension service worker restarts)`);

    const { ctx, width, height } = await captureForDiff(tabId, selector ?? base.selector ?? undefined);
    if (width !== base.width || height !== base.height) {
      return {
        match: false,
        reason: 'size_mismatch',
        baseline: { width: base.width, height: base.height },
        current: { width, height },
      };
    }

    const cur = ctx.getImageData(0, 0, width, height);
    const a = base.bitmapData.data;
    const b = cur.data;
    const diffCanvas = new OffscreenCanvas(width, height);
    const diffCtx = diffCanvas.getContext('2d');
    const out = diffCtx.createImageData(width, height);
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) {
      const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (delta > threshold * 3) {
        changed++;
        out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 0; out.data[i + 3] = 255;
      } else {
        // Base sbiadita per contesto
        const gray = (a[i] + a[i + 1] + a[i + 2]) / 3;
        out.data[i] = gray; out.data[i + 1] = gray; out.data[i + 2] = gray; out.data[i + 3] = 80;
      }
    }
    diffCtx.putImageData(out, 0, 0);
    const totalPixels = width * height;
    const diffPercent = (changed / totalPixels) * 100;
    return {
      match: changed === 0,
      diff_percent: Math.round(diffPercent * 100) / 100,
      changed_pixels: changed,
      total_pixels: totalPixels,
      diff_image: await canvasToBase64(diffCanvas),
    };
  }

  throw new Error(`Unknown action: ${action}`);
}

// --- web_vitals ---

async function cmdWebVitals({ tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const v = window.__chromeBridge_vitals;
      if (!v) return { available: false, note: 'Instrumentation not loaded (page opened before extension, or chrome:// page)' };
      const nav = performance.getEntriesByType('navigation')[0];
      const paint = {};
      for (const p of performance.getEntriesByType('paint')) paint[p.name] = Math.round(p.startTime);
      return {
        available: true,
        cls: Math.round(v.cls * 1000) / 1000,
        lcp_ms: v.lcp,
        fcp_ms: paint['first-contentful-paint'] ?? null,
        ttfb_ms: nav ? Math.round(nav.responseStart - nav.requestStart) : null,
        long_tasks: v.longTasks,
        max_event_duration_ms: v.maxEventDelayMs,
      };
    },
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { available: false };
}

// --- list_event_listeners ---

async function cmdListEventListeners({ type, limit = 100, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (filterType, lim) => {
      const all = window.__chromeBridge_listeners || [];
      const filtered = filterType ? all.filter((l) => l.type === filterType) : all;
      const byType = {};
      for (const l of filtered) byType[l.type] = (byType[l.type] || 0) + 1;
      return {
        total: filtered.length,
        by_type: byType,
        listeners: filtered.slice(-lim),
        note: window.__chromeBridge_listeners ? undefined : 'Instrumentation not loaded for this page',
      };
    },
    args: [type ?? null, limit],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { total: 0, by_type: {}, listeners: [] };
}

// --- monitor_websocket (hook lazy, come ensureNetworkHook) ---

async function ensureWsHook(tabId) {
  if (injectedTabs.websocket.has(tabId)) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (window.__chromeBridge_wsHooked) return;
      window.__chromeBridge_wsHooked = true;
      window.__chromeBridge_wsLog = [];
      const MAX = 500;
      const PREVIEW = 500;
      const push = (entry) => {
        if (window.__chromeBridge_wsLog.length >= MAX) window.__chromeBridge_wsLog.shift();
        window.__chromeBridge_wsLog.push(entry);
      };
      const preview = (data) => {
        try {
          if (typeof data === 'string') return data.substring(0, PREVIEW);
          return `<binary ${data?.byteLength ?? data?.size ?? '?'} bytes>`;
        } catch { return '<unreadable>'; }
      };
      const OrigWS = window.WebSocket;
      window.WebSocket = function (url, protocols) {
        const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
        push({ event: 'open_attempt', url: String(url), timestamp: Date.now() });
        ws.addEventListener('open', () => push({ event: 'open', url: String(url), timestamp: Date.now() }));
        ws.addEventListener('close', (e) => push({ event: 'close', url: String(url), code: e.code, timestamp: Date.now() }));
        ws.addEventListener('error', () => push({ event: 'error', url: String(url), timestamp: Date.now() }));
        ws.addEventListener('message', (e) => push({ event: 'message', direction: 'in', url: String(url), data: preview(e.data), timestamp: Date.now() }));
        const origSend = ws.send.bind(ws);
        ws.send = (data) => {
          push({ event: 'message', direction: 'out', url: String(url), data: preview(data), timestamp: Date.now() });
          return origSend(data);
        };
        return ws;
      };
      window.WebSocket.prototype = OrigWS.prototype;
      Object.setPrototypeOf(window.WebSocket, OrigWS);
      for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) window.WebSocket[k] = OrigWS[k];
    },
    world: 'MAIN',
  });
  injectedTabs.websocket.add(tabId);
}

async function cmdMonitorWebsocket({ clear = false, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  await ensureWsHook(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (shouldClear) => {
      const log = window.__chromeBridge_wsLog || [];
      const out = [...log];
      if (shouldClear) window.__chromeBridge_wsLog = [];
      return out;
    },
    args: [clear],
    world: 'MAIN',
  });
  const events = results?.[0]?.result ?? [];
  return { count: events.length, events };
}

// --- seo_audit ---

async function cmdSeoAudit({ tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const findings = [];
      const add = (type, severity, message, value) => {
        const f = { type, severity, message };
        if (value !== undefined) f.value = value;
        findings.push(f);
      };

      // Title
      const title = (document.title || '').trim();
      if (!title) add('title', 'error', 'Missing <title>');
      else if (title.length < 15) add('title', 'warning', 'Title too short', title.length);
      else if (title.length > 60) add('title', 'warning', 'Title too long', title.length);

      // Meta description
      const descEl = document.querySelector('meta[name="description"]');
      const desc = descEl ? (descEl.getAttribute('content') || '').trim() : '';
      if (!desc) add('meta_description', 'error', 'Missing meta description');
      else if (desc.length < 50) add('meta_description', 'warning', 'Meta description too short', desc.length);
      else if (desc.length > 160) add('meta_description', 'warning', 'Meta description too long', desc.length);

      // Canonical
      const canonical = document.querySelector('link[rel="canonical"]');
      if (!canonical) {
        add('canonical', 'warning', 'Missing canonical link');
      } else {
        add('canonical', 'info', 'Canonical present', canonical.href);
        const stripHash = (u) => u.split('#')[0];
        if (canonical.href && stripHash(canonical.href) !== stripHash(location.href)) {
          add('canonical', 'info', 'Canonical differs from current URL', canonical.href);
        }
      }

      // Robots meta
      const robots = document.querySelector('meta[name="robots"]');
      if (!robots) {
        add('robots', 'info', 'No robots meta (default: index,follow)');
      } else {
        const content = robots.getAttribute('content') || '';
        if (content.toLowerCase().includes('noindex')) add('robots', 'warning', 'Page is noindex', content);
      }

      // h1 count
      const h1Count = document.querySelectorAll('h1').length;
      if (h1Count === 0) add('h1', 'error', 'No h1 on page');
      else if (h1Count > 1) add('h1', 'warning', 'Multiple h1 elements', h1Count);

      // Open Graph
      for (const prop of ['og:title', 'og:description', 'og:image']) {
        if (!document.querySelector(`meta[property="${prop}"]`)) {
          add('open_graph', 'warning', `Missing ${prop}`);
        }
      }

      // Twitter card
      if (!document.querySelector('meta[name="twitter:card"]')) {
        add('twitter_card', 'info', 'Missing twitter:card meta');
      }

      // JSON-LD
      const ldScripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
      ldScripts.forEach((script, i) => {
        try {
          const data = JSON.parse(script.textContent);
          const types = [];
          const collect = (node) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) { node.forEach(collect); return; }
            if (node['@type']) types.push(...[].concat(node['@type']));
            if (node['@graph']) collect(node['@graph']);
          };
          collect(data);
          add('json_ld', 'info', `JSON-LD block ${i + 1}/${ldScripts.length} is valid`, types.length ? types.join(', ') : 'no @type');
        } catch (e) {
          add('json_ld', 'error', `JSON-LD block ${i + 1}/${ldScripts.length} parse error: ${e.message}`);
        }
      });

      // hreflang
      const hreflangCount = document.querySelectorAll('link[rel="alternate"][hreflang]').length;
      if (hreflangCount > 0) add('hreflang', 'info', 'hreflang alternates present', hreflangCount);

      // lang attribute
      if (!document.documentElement.getAttribute('lang')) {
        add('lang', 'warning', 'Missing lang attribute on <html>');
      }

      // Viewport meta
      if (!document.querySelector('meta[name="viewport"]')) {
        add('viewport', 'error', 'No viewport meta (not mobile-friendly)');
      }

      // Favicon
      if (!document.querySelector('link[rel*="icon"]')) {
        add('favicon', 'info', 'No favicon link found');
      }

      // Images without alt
      const noAltCount = [...document.querySelectorAll('img')].filter((img) => !img.hasAttribute('alt')).length;
      if (noAltCount > 0) {
        add('images', 'warning', `${noAltCount} images without alt attribute (accessibility_audit has details)`, noAltCount);
      }

      const errors = findings.filter((f) => f.severity === 'error').length;
      const warnings = findings.filter((f) => f.severity === 'warning').length;
      const info = findings.filter((f) => f.severity === 'info').length;
      return {
        summary: { errors, warnings, info },
        findings,
        page: { title, url: location.href },
      };
    },
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { summary: { errors: 0, warnings: 0, info: 0 }, findings: [], page: {} };
}

// --- extract_table ---

async function cmdExtractTable({ selector = 'table', index = 0, max_rows = 100, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, idx, maxRows) => {
      const tables = document.querySelectorAll(sel);
      const table = tables[idx];
      if (!table) {
        throw new Error(`No table found for selector "${sel}" at index ${idx} (${tables.length} found)`);
      }

      const cellText = (cell) => (cell.textContent || '').trim();

      // Headers: thead th, or first row's th/td as fallback
      let headers = [];
      let bodyRows;
      const thead = table.querySelector('thead');
      if (thead && thead.rows.length > 0) {
        headers = [...thead.rows[0].cells].map(cellText);
        bodyRows = table.tBodies.length
          ? [].concat(...[...table.tBodies].map((tb) => [...tb.rows]))
          : [...table.rows].filter((r) => !thead.contains(r));
      } else {
        const allRows = [...table.rows];
        if (allRows.length > 0 && [...allRows[0].cells].some((c) => c.tagName === 'TH')) {
          headers = [...allRows[0].cells].map(cellText);
          bodyRows = allRows.slice(1);
        } else {
          bodyRows = allRows;
        }
      }

      const rowCount = bodyRows.length;
      const capped = bodyRows.slice(0, maxRows);
      const headersUsable = headers.length > 0
        && headers.every((h) => h !== '')
        && new Set(headers).size === headers.length;

      const rows = capped.map((tr) => {
        const cells = [...tr.cells].map(cellText);
        if (!headersUsable) return cells;
        const obj = {};
        headers.forEach((h, i) => { obj[h] = cells[i] ?? ''; });
        return obj;
      });

      return {
        caption: table.caption ? cellText(table.caption) : null,
        headers,
        row_count: rowCount,
        rows,
        truncated: rowCount > maxRows,
        tables_found: tables.length,
      };
    },
    args: [selector, index, max_rows],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { headers: [], rows: [], row_count: 0, truncated: false, tables_found: 0 };
}

// --- unused_css ---

async function cmdUnusedCss({ max_selectors = 200, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (maxSelectors) => {
      const sheets = [];
      const unusedSelectors = [];
      let totalUnused = 0;
      let totalChecked = 0;
      let totalSkipped = 0;

      for (const sheet of document.styleSheets) {
        const sheetInfo = { href: sheet.href || 'inline', accessible: true, total_rules: 0, unused_count: 0 };
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          sheetInfo.accessible = false;
          sheets.push(sheetInfo);
          continue;
        }

        // Flatten media/supports rules one level
        const styleRules = [];
        for (const rule of rules) {
          if (rule instanceof CSSStyleRule) {
            styleRules.push(rule);
          } else if ((rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) && rule.cssRules) {
            for (const inner of rule.cssRules) {
              if (inner instanceof CSSStyleRule) styleRules.push(inner);
            }
          }
        }
        sheetInfo.total_rules = styleRules.length;

        for (const rule of styleRules) {
          const selectors = (rule.selectorText || '').split(',');
          for (const rawSel of selectors) {
            const cleaned = rawSel.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '').trim();
            if (!cleaned || /^[>+~\s]*$/.test(cleaned)) continue;
            totalChecked++;
            let matched;
            try {
              matched = document.querySelector(cleaned) !== null;
            } catch {
              totalSkipped++;
              continue;
            }
            if (!matched) {
              totalUnused++;
              sheetInfo.unused_count++;
              if (unusedSelectors.length < maxSelectors) unusedSelectors.push(rawSel.trim());
            }
          }
        }
        sheets.push(sheetInfo);
      }

      return {
        sheets,
        unused_selectors: unusedSelectors,
        total_unused: totalUnused,
        total_checked: totalChecked,
        skipped: totalSkipped,
        note: 'Approximate: only current DOM state; dynamic/JS-toggled selectors may be falsely reported',
      };
    },
    args: [max_selectors],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { sheets: [], unused_selectors: [], total_unused: 0, total_checked: 0 };
}

// --- drag_and_drop ---

async function cmdDragAndDrop({ source_selector, target_selector, mode = 'html5', tab_id, frame_id }) {
  if (!source_selector) throw new Error('Missing required parameter: source_selector');
  if (!target_selector) throw new Error('Missing required parameter: target_selector');
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: scriptTarget(tabId, frame_id),
    func: async (srcSel, tgtSel, dndMode) => {
      const src = document.querySelector(srcSel);
      if (!src) throw new Error(`Source element not found: ${srcSel}`);
      const tgt = document.querySelector(tgtSel);
      if (!tgt) throw new Error(`Target element not found: ${tgtSel}`);
      src.scrollIntoView({ block: 'center', behavior: 'instant' });
      const sr = src.getBoundingClientRect();
      const tr = tgt.getBoundingClientRect();
      const sc = { x: sr.left + sr.width / 2, y: sr.top + sr.height / 2 };
      const tc = { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2 };
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      if (dndMode === 'html5') {
        const dt = new DataTransfer();
        const fire = (el, type, x, y) => el.dispatchEvent(new DragEvent(type, {
          bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt,
        }));
        fire(src, 'dragstart', sc.x, sc.y);
        await sleep(50);
        fire(tgt, 'dragenter', tc.x, tc.y);
        fire(tgt, 'dragover', tc.x, tc.y);
        await sleep(50);
        fire(tgt, 'drop', tc.x, tc.y);
        fire(src, 'dragend', tc.x, tc.y);
      } else {
        // pointer mode: per librerie sortable basate su pointer/mouse events
        const fire = (el, type, x, y, Ctor = PointerEvent) => el.dispatchEvent(new Ctor(type, {
          bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type.includes('up') ? 0 : 1, pointerId: 1, isPrimary: true,
        }));
        fire(src, 'pointerdown', sc.x, sc.y);
        fire(src, 'mousedown', sc.x, sc.y, MouseEvent);
        await sleep(50);
        // movimento intermedio
        const mid = { x: (sc.x + tc.x) / 2, y: (sc.y + tc.y) / 2 };
        for (const p of [mid, tc]) {
          fire(document, 'pointermove', p.x, p.y);
          fire(document, 'mousemove', p.x, p.y, MouseEvent);
          await sleep(50);
        }
        fire(tgt, 'pointerup', tc.x, tc.y);
        fire(tgt, 'mouseup', tc.x, tc.y, MouseEvent);
      }
      return { dragged: srcSel, dropped_on: tgtSel, mode: dndMode };
    },
    args: [source_selector, target_selector, mode],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { dragged: false };
}

// --- clipboard ---

async function cmdClipboard({ action, text, tab_id }) {
  if (!action) throw new Error('Missing required parameter: action');
  const tabId = await resolveTabId(tab_id);
  // La pagina deve essere focalizzata per navigator.clipboard
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    // World ISOLATED di proposito: le permission clipboardRead/clipboardWrite
    // dell'estensione si applicano al suo isolated world, rendendo execCommand
    // funzionante senza user gesture.
    func: async (act, txt) => {
      if (act === 'write') {
        if (txt === undefined || txt === null) throw new Error('Missing required parameter: text');
        try {
          await navigator.clipboard.writeText(txt);
          return { written: true, length: txt.length, method: 'clipboard-api' };
        } catch (e) {
          // Fallback execCommand
          const ta = document.createElement('textarea');
          ta.value = txt;
          ta.style.cssText = 'position:fixed;opacity:0;';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          if (!ok) throw new Error(`Clipboard write failed: ${e.message}`);
          return { written: true, length: txt.length, method: 'execCommand' };
        }
      }
      if (act === 'read') {
        try {
          const value = await navigator.clipboard.readText();
          return { text: value, method: 'clipboard-api' };
        } catch (e) {
          // Nessun fallback: execCommand('paste') è stato rimosso da Chrome 86+.
          throw new Error(`Clipboard read failed: ${e.message} (page may need focus)`);
        }
      }
      throw new Error(`Unknown action: ${act}`);
    },
    args: [action, text ?? null],
    world: 'ISOLATED',
  });
  return results?.[0]?.result ?? {};
}

// --- set_geolocation ---

async function cmdSetGeolocation({ latitude, longitude, accuracy = 10, reset = false, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (lat, lng, acc, doReset) => {
      if (doReset) {
        if (window.__chromeBridge_origGeo) {
          navigator.geolocation.getCurrentPosition = window.__chromeBridge_origGeo.getCurrentPosition;
          navigator.geolocation.watchPosition = window.__chromeBridge_origGeo.watchPosition;
          delete window.__chromeBridge_origGeo;
        }
        return { reset: true };
      }
      if (lat === null || lng === null) throw new Error('Missing required parameters: latitude, longitude');
      if (!window.__chromeBridge_origGeo) {
        window.__chromeBridge_origGeo = {
          getCurrentPosition: navigator.geolocation.getCurrentPosition.bind(navigator.geolocation),
          watchPosition: navigator.geolocation.watchPosition.bind(navigator.geolocation),
        };
      }
      const makePosition = () => ({
        coords: {
          latitude: lat, longitude: lng, accuracy: acc,
          altitude: null, altitudeAccuracy: null, heading: null, speed: null,
        },
        timestamp: Date.now(),
      });
      navigator.geolocation.getCurrentPosition = (success) => {
        setTimeout(() => success(makePosition()), 10);
      };
      navigator.geolocation.watchPosition = (success) => {
        setTimeout(() => success(makePosition()), 10);
        return Math.floor(Math.random() * 1000000);
      };
      return { emulated: { latitude: lat, longitude: lng, accuracy: acc } };
    },
    args: [latitude ?? null, longitude ?? null, accuracy, reset],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? {};
}

// --- manage_downloads ---

async function cmdManageDownloads({ action, timeout = 30000, limit = 10 }) {
  if (!action) throw new Error('Missing required parameter: action');

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

// --- save_page (MHTML via pageCapture) ---

async function cmdSavePage({ tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const blob = await new Promise((resolve, reject) => {
    chrome.pageCapture.saveAsMHTML({ tabId }, (data) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(data);
    });
  });
  return { mhtml_b64: await blobToBase64(blob), size: blob.size };
}

// --- set_zoom ---

async function cmdSetZoom({ factor, reset = false, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  if (reset) {
    await chrome.tabs.setZoom(tabId, 0); // 0 = default zoom
  } else if (factor !== undefined && factor !== null) {
    if (factor < 0.25 || factor > 5) throw new Error('factor must be between 0.25 and 5');
    await chrome.tabs.setZoom(tabId, factor);
  }
  const current = await chrome.tabs.getZoom(tabId);
  return { zoom: current };
}

// --- Browser-level network log (webRequest) ---
const browserNetLog = new Map(); // tabId → array

function pushNetEntry(tabId, entry) {
  if (tabId < 0) return;
  let arr = browserNetLog.get(tabId);
  if (!arr) { arr = []; browserNetLog.set(tabId, arr); }
  if (arr.length >= 500) arr.shift();
  arr.push(entry);
}

chrome.webRequest.onCompleted.addListener((d) => {
  pushNetEntry(d.tabId, { source: 'browser', type: d.type, method: d.method, url: d.url, status: d.statusCode, startTime: d.timeStamp, duration: null, fromCache: d.fromCache, ip: d.ip || null });
}, { urls: ['<all_urls>'] });

chrome.webRequest.onErrorOccurred.addListener((d) => {
  pushNetEntry(d.tabId, { source: 'browser', type: d.type, method: d.method, url: d.url, status: 0, startTime: d.timeStamp, duration: null, error: d.error });
}, { urls: ['<all_urls>'] });

// --- Cattura header risposta main_frame (per security_headers) ---
const mainFrameHeaders = new Map(); // tabId → { url, status, headers: {name(lc): value}, capturedAt }

// Limite: header duplicati (es. CSP multiple) vengono sovrascritti — vince l'ultimo, solo quello viene auditato.
chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0 || d.type !== 'main_frame') return;
  const headers = {};
  for (const h of d.responseHeaders || []) {
    headers[h.name.toLowerCase()] = h.value ?? '';
  }
  mainFrameHeaders.set(d.tabId, { url: d.url, status: d.statusCode, headers, capturedAt: Date.now() });
}, { urls: ['<all_urls>'], types: ['main_frame'] }, ['responseHeaders']);

async function cmdGetResponseHeaders({ tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const entry = mainFrameHeaders.get(tabId);
  if (!entry) {
    return { available: false, note: 'No headers captured for this tab — reload the page (headers are captured from navigations after the extension loaded)' };
  }
  return { available: true, ...entry };
}

// --- http_auth (credenziali per HTTP Basic/Digest auth) ---

let httpAuthCreds = null; // { username, password }
const httpAuthAttempted = new Set(); // requestId già serviti (anti-loop)

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!httpAuthCreds || httpAuthAttempted.has(details.requestId)) {
      callback({});
      return;
    }
    httpAuthAttempted.add(details.requestId);
    if (httpAuthAttempted.size > 500) httpAuthAttempted.clear();
    callback({ authCredentials: { username: httpAuthCreds.username, password: httpAuthCreds.password } });
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

async function cmdHttpAuth({ action, username, password }) {
  if (!action) throw new Error('Missing required parameter: action');
  if (action === 'set') {
    if (!username) throw new Error('Missing required parameter: username');
    httpAuthCreds = { username, password: password || '' };
    return { set: true, username };
  }
  if (action === 'clear') {
    httpAuthCreds = null;
    httpAuthAttempted.clear();
    return { cleared: true };
  }
  throw new Error(`Unknown action: ${action}`);
}

// --- Tab lifecycle: cleanup injection state ---

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    injectedTabs.network.delete(tabId);
    injectedTabs.websocket.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.network.delete(tabId);
  injectedTabs.websocket.delete(tabId);
  browserNetLog.delete(tabId);
  mainFrameHeaders.delete(tabId);
});

// --- Avvia la connessione ---
loadConfig().then(connect);
