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

// --- Avvia la connessione ---
connect();
