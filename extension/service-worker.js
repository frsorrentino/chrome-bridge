/**
 * Chrome Bridge — Service Worker
 *
 * Mantiene una connessione WebSocket al server MCP in Crostini.
 * Riceve comandi, li esegue tramite Chrome APIs, e invia le risposte.
 */

const WS_URL = 'ws://localhost:8765';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const KEEPALIVE_ALARM = 'chrome-bridge-keepalive';

let ws = null;
let reconnectDelay = RECONNECT_BASE_MS;
let connectionState = 'disconnected'; // 'connected' | 'connecting' | 'disconnected'

// Tracking per tool stateful (console/network monkey-patch)
const injectedTabs = { console: new Set(), network: new Set() };

// --- Keep-alive: impedisce che il service worker venga fermato ---
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // ~24s
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
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setConnectionState('connecting');

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.error('[chrome-bridge] WebSocket creation error:', err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[chrome-bridge] Connected to MCP server');
    setConnectionState('connected');
    reconnectDelay = RECONNECT_BASE_MS; // Reset backoff
  };

  ws.onclose = () => {
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
  setTimeout(() => {
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
    default:
      throw new Error(`Unknown command type: ${type}`);
  }
}

// --- Utility: risolvi tab_id ---

async function resolveTabId(tab_id) {
  if (tab_id) return tab_id;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab.id;
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
  const tab = await chrome.tabs.update(tabId, { url });

  // Attendi che il caricamento sia completo
  await new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Timeout di sicurezza
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });

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

async function cmdExecuteJs({ code, tab_id }) {
  if (!code) throw new Error('Missing required parameter: code');
  const tabId = await resolveTabId(tab_id);

  // Strategia: ISOLATED world (no CSP restrizioni dalla pagina)
  // per accesso DOM + eval del codice utente.
  // Fallback: MAIN world per accesso a variabili della pagina.
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
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
        target: { tabId },
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

async function cmdClick({ selector, tab_id }) {
  if (!selector) throw new Error('Missing required parameter: selector');
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);
      el.click();
      return { tagName: el.tagName, text: el.textContent?.substring(0, 100) };
    },
    args: [selector],
    world: 'MAIN',
  });

  return results?.[0]?.result ?? { clicked: true };
}

async function cmdTypeText({ selector, text, tab_id }) {
  if (!selector) throw new Error('Missing required parameter: selector');
  if (text === undefined) throw new Error('Missing required parameter: text');
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, txt) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);
      el.focus();
      el.value = txt;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { typed: true };
    },
    args: [selector, text],
    world: 'MAIN',
  });

  return results?.[0]?.result ?? { typed: true };
}

async function cmdReadPage({ mode = 'text', tab_id }) {
  const tabId = await resolveTabId(tab_id);

  if (mode === 'html') {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML,
      world: 'MAIN',
    });
    return results?.[0]?.result ?? '';
  }

  if (mode === 'accessibility') {
    // Ritorna una struttura semplificata dell'a11y tree
    const results = await chrome.scripting.executeScript({
      target: { tabId },
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
    target: { tabId },
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
    await new Promise((resolve) => {
      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tab.id && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 15000);
    });
    const updated = await chrome.tabs.get(tab.id);
    return { id: updated.id, url: updated.url, title: updated.title };
  }
  return { id: tab.id, url: tab.url || 'chrome://newtab', title: tab.title || '' };
}

// --- DevTools: get_page_info ---

async function cmdGetPageInfo({ tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
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
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (storageType) => {
      const data = {};
      if (storageType === 'all' || storageType === 'localStorage') {
        const ls = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          ls[key] = localStorage.getItem(key);
        }
        data.localStorage = ls;
      }
      if (storageType === 'all' || storageType === 'sessionStorage') {
        const ss = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          ss[key] = sessionStorage.getItem(key);
        }
        data.sessionStorage = ss;
      }
      if (storageType === 'all' || storageType === 'cookies') {
        data.cookies = document.cookie || '';
      }
      return data;
    },
    args: [type],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? {};
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

async function cmdQueryDom({ selector, properties, limit = 50, tab_id }) {
  if (!selector) throw new Error('Missing required parameter: selector');
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, props, lim) => {
      const els = [...document.querySelectorAll(sel)].slice(0, lim);
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

async function cmdModifyDom({ selector, action, name, value, className, tab_id }) {
  if (!selector) throw new Error('Missing required parameter: selector');
  if (!action) throw new Error('Missing required parameter: action');
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
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

// --- DevTools: read_console (stateful) ---

async function cmdReadConsole({ clear = false, level = 'all', tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const needsInjection = !injectedTabs.console.has(tabId);

  if (needsInjection) {
    // Inject monkey-patch nel MAIN world
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (window.__chromeBridge_consoleHooked) return;
        window.__chromeBridge_consoleHooked = true;
        window.__chromeBridge_consoleLogs = [];
        const MAX = 1000;
        const originals = {};
        for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
          originals[method] = console[method].bind(console);
          console[method] = (...args) => {
            if (window.__chromeBridge_consoleLogs.length < MAX) {
              window.__chromeBridge_consoleLogs.push({
                level: method,
                args: args.map((a) => {
                  try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
                  catch { return String(a); }
                }),
                timestamp: Date.now(),
              });
            }
            originals[method](...args);
          };
        }
      },
      world: 'MAIN',
    });
    injectedTabs.console.add(tabId);
  }

  // Leggi i log
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

async function cmdMonitorNetwork({ clear = false, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const needsInjection = !injectedTabs.network.has(tabId);

  if (needsInjection) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (window.__chromeBridge_networkHooked) return;
        window.__chromeBridge_networkHooked = true;
        window.__chromeBridge_networkRequests = [];
        const MAX = 1000;

        // --- Patch fetch ---
        const origFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const req = args[0];
          const url = typeof req === 'string' ? req : req?.url || String(req);
          const method = (args[1]?.method || (req?.method) || 'GET').toUpperCase();
          const entry = { type: 'fetch', method, url, startTime: Date.now(), status: null, duration: null, error: null };
          try {
            const resp = await origFetch(...args);
            entry.status = resp.status;
            entry.duration = Date.now() - entry.startTime;
            if (window.__chromeBridge_networkRequests.length < MAX) {
              window.__chromeBridge_networkRequests.push(entry);
            }
            return resp;
          } catch (err) {
            entry.error = err.message;
            entry.duration = Date.now() - entry.startTime;
            if (window.__chromeBridge_networkRequests.length < MAX) {
              window.__chromeBridge_networkRequests.push(entry);
            }
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
          return origSend.apply(this, args);
        };
      },
      world: 'MAIN',
    });
    injectedTabs.network.add(tabId);
  }

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

// --- Tab lifecycle: cleanup injection state ---

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    injectedTabs.console.delete(tabId);
    injectedTabs.network.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.console.delete(tabId);
  injectedTabs.network.delete(tabId);
});

// --- Avvia la connessione ---
connect();
