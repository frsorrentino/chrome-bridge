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
const injectedTabs = { console: new Set(), network: new Set(), dom: new Set() };

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
    case 'highlight_elements':
      return await cmdHighlightElements(params);
    case 'accessibility_audit':
      return await cmdAccessibilityAudit(params);
    case 'check_links':
      return await cmdCheckLinks(params);
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

// --- wait_for_element ---

async function cmdWaitForElement({ selector, timeout = 10000, interval = 200, visible = false, tab_id }) {
  if (!selector) throw new Error('Missing required parameter: selector');
  const tabId = await resolveTabId(tab_id);
  const clampedInterval = Math.max(interval, 50);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, tout, intv, vis) => {
      return new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
          const el = document.querySelector(sel);
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

async function cmdScrollTo({ selector, x, y, behavior = 'auto', offset_y = 0, tab_id }) {
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
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

async function cmdSetStorage({ type, action, key, value, path, domain, expires, secure, sameSite, tab_id }) {
  if (!type) throw new Error('Missing required parameter: type');
  if (!action) throw new Error('Missing required parameter: action');
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sType, sAction, sKey, sValue, cPath, cDomain, cExpires, cSecure, cSameSite) => {
      if (sType === 'localStorage' || sType === 'sessionStorage') {
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
      } else if (sType === 'cookie') {
        if (sAction === 'set') {
          if (!sKey) throw new Error('key is required for set action');
          let cookie = `${encodeURIComponent(sKey)}=${encodeURIComponent(sValue || '')}`;
          cookie += `; path=${cPath || '/'}`;
          if (cDomain) cookie += `; domain=${cDomain}`;
          if (cExpires) cookie += `; expires=${cExpires}`;
          if (cSameSite) {
            cookie += `; SameSite=${cSameSite}`;
            if (cSameSite === 'None') cookie += '; Secure';
          }
          if (cSecure && (!cSameSite || cSameSite !== 'None')) cookie += '; Secure';
          document.cookie = cookie;
          return { success: true, type: 'cookie', action: 'set', key: sKey };
        } else if (sAction === 'delete') {
          if (!sKey) throw new Error('key is required for delete action');
          document.cookie = `${encodeURIComponent(sKey)}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${cPath || '/'}`;
          return { success: true, type: 'cookie', action: 'delete', key: sKey };
        } else if (sAction === 'clear') {
          const cookies = document.cookie.split(';');
          for (const c of cookies) {
            const name = c.split('=')[0].trim();
            if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${cPath || '/'}`;
          }
          return { success: true, type: 'cookie', action: 'clear', cleared: cookies.length };
        }
      }
      throw new Error(`Invalid type/action: ${sType}/${sAction}`);
    },
    args: [type, action, key || null, value || null, path || null, domain || null, expires || null, secure || false, sameSite || null],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { success: false };
}

// --- fill_form ---

async function cmdFillForm({ fields, submit_selector, tab_id }) {
  if (!fields || !Array.isArray(fields)) throw new Error('Missing required parameter: fields');
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
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

async function cmdFullPageScreenshot({ max_scrolls = 20, delay = 200, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });

  // Get page dimensions
  const dimResults = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      originalScrollY: window.scrollY,
    }),
    world: 'MAIN',
  });
  const dims = dimResults?.[0]?.result ?? {};
  const { scrollHeight, viewportHeight, originalScrollY } = dims;
  const captures = [];
  const steps = Math.min(Math.ceil(scrollHeight / viewportHeight), max_scrolls);

  for (let i = 0; i < steps; i++) {
    const scrollY = i * viewportHeight;
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (sy) => window.scrollTo(0, sy),
      args: [scrollY],
      world: 'MAIN',
    });
    await new Promise((r) => setTimeout(r, delay));
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    captures.push(dataUrl.replace(/^data:image\/png;base64,/, ''));
  }

  // Restore scroll position
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (sy) => window.scrollTo(0, sy),
    args: [originalScrollY],
    world: 'MAIN',
  });

  return { captures, scrollHeight, viewportHeight, totalCaptures: captures.length };
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

      // Contrast (basic)
      if (runAll || checkList.includes('contrast')) {
        const textEls = [...root.querySelectorAll('p, span, a, li, td, th, label, h1, h2, h3, h4, h5, h6')].slice(0, 200);
        for (const el of textEls) {
          if (!el.textContent.trim()) continue;
          const style = getComputedStyle(el);
          const color = style.color;
          const bg = style.backgroundColor;
          // Simple check: both same → bad. Only flag obvious issues.
          if (color && bg && color === bg && color !== 'rgba(0, 0, 0, 0)') {
            violations.push({ type: 'contrast', severity: 'error', selector: selectorFor(el), message: `Text color matches background: ${color}` });
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

// --- check_links ---

async function cmdCheckLinks({ scope = 'all', selector = 'a[href]', timeout = 5000, max_links = 50, tab_id }) {
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (sel, linkScope, perLinkTimeout, maxLinks) => {
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
        } catch {
          continue;
        }

        if (links.length >= maxLinks) break;
      }

      const checkResults = await Promise.allSettled(links.map(async ({ url, text }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), perLinkTimeout);
        try {
          const resp = await fetch(url, { method: 'HEAD', mode: 'no-cors', signal: controller.signal });
          clearTimeout(timer);
          // no-cors: status=0 (opaque), not broken
          return { url, text, status: resp.status, ok: resp.ok || resp.status === 0, broken: resp.status >= 400 };
        } catch (headErr) {
          clearTimeout(timer);
          // Retry with GET for servers that reject HEAD
          try {
            const controller2 = new AbortController();
            const timer2 = setTimeout(() => controller2.abort(), perLinkTimeout);
            const resp = await fetch(url, { method: 'GET', mode: 'no-cors', signal: controller2.signal });
            clearTimeout(timer2);
            return { url, text, status: resp.status, ok: resp.ok || resp.status === 0, broken: resp.status >= 400 };
          } catch (getErr) {
            return { url, text, status: 0, ok: false, broken: false, error: getErr.message || 'Network error' };
          }
        }
      }));

      const mapped = checkResults.map((r) => r.status === 'fulfilled' ? r.value : { url: '?', status: 0, ok: false, broken: false, error: r.reason?.message });
      const broken = mapped.filter((r) => r.broken).length;
      return { total: links.length, checked: mapped.length, broken, results: mapped };
    },
    args: [selector, scope, timeout, max_links],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { total: 0, checked: 0, broken: 0, results: [] };
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
  const needsInjection = !injectedTabs.dom.has(tabId);

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
    injectedTabs.dom.delete(tabId);
    return { stopped: true, count: 0, mutations: [] };
  }

  if (needsInjection) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, opts) => {
        if (window.__chromeBridge_domWatcherHooked) return;
        window.__chromeBridge_domWatcherHooked = true;
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
    injectedTabs.dom.add(tabId);
  }

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

      // Override matchMedia for JS-based checks
      const orig = window.__chromeBridge_origMatchMedia;
      window.matchMedia = (query) => {
        const result = orig(query);
        for (const [feature, val] of Object.entries(overrides)) {
          if (feature === 'print' && query.includes('print')) {
            return { ...result, matches: true, media: query };
          }
          if (query.includes(feature) && query.includes(val)) {
            return { ...result, matches: true, media: query };
          }
          if (query.includes(feature) && !query.includes(val)) {
            return { ...result, matches: false, media: query };
          }
        }
        return result;
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

async function cmdHover({ selector, tab_id }) {
  if (!selector) throw new Error('Missing required parameter: selector');
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const el = document.querySelector(sel);
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

async function cmdPressKey({ key, selector, ctrl = false, shift = false, alt = false, meta = false, tab_id }) {
  if (!key) throw new Error('Missing required parameter: key');
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (k, sel, mods) => {
      const el = sel ? document.querySelector(sel) : document.activeElement || document.body;
      if (sel && !document.querySelector(sel)) throw new Error(`Element not found: ${sel}`);
      const opts = {
        key: k,
        code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
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

// --- Tab lifecycle: cleanup injection state ---

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    injectedTabs.console.delete(tabId);
    injectedTabs.network.delete(tabId);
    injectedTabs.dom.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.console.delete(tabId);
  injectedTabs.network.delete(tabId);
  injectedTabs.dom.delete(tabId);
});

// --- Avvia la connessione ---
connect();
