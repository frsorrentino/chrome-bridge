# Popup Redesign 1.7.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trasformare il popup dell'extension in uno strumento di troubleshooting con tema auto dark/light, warning userScripts prominente, telemetria sessione e info sulla pagina corrente.

**Architecture:** Il service worker (MV3, module) accumula contatori sessione in `chrome.storage.session` e risponde a tre nuovi messaggi runtime (`getPopupData`, `getPageInfo`, `reconnect`). Il server risponde a `ext_init` con `ext_init_ok { version }`. Il popup è vanilla HTML/CSS/JS con CSS variables + `prefers-color-scheme`. Le parti pure (ring buffer, report diagnostica, stack detection) vivono in file separati con export su `globalThis` per essere unit-testabili da Node.

**Tech Stack:** Vanilla JS (ESM), chrome.scripting, chrome.storage.session, node --test.

**Spec:** `docs/superpowers/specs/2026-07-13-popup-redesign-design.md`

**Convenzione test:** i file extension sono script senza `import`/`export` (parsabili come ESM). Espongono le funzioni su `globalThis.__cb*`; i test li importano per side effect:
```js
import '../../extension/telemetry.js';
const { pushError } = globalThis.__cbTelemetry;
```

---

### Task 1: telemetry.js — ring buffer errori + report diagnostica

**Files:**
- Create: `extension/telemetry.js`
- Test: `test/unit/telemetry.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/telemetry.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/telemetry.js';

const { pushError, buildDiagnostics } = globalThis.__cbTelemetry;

test('pushError accoda e limita a max (default 5)', () => {
  let buf = [];
  for (let i = 1; i <= 7; i++) buf = pushError(buf, { ts: i, tool: 't', message: `e${i}` });
  assert.equal(buf.length, 5);
  assert.equal(buf[0].message, 'e3'); // i più vecchi cadono
  assert.equal(buf[4].message, 'e7');
});

test('pushError non muta il buffer originale', () => {
  const orig = [{ ts: 1, tool: 'a', message: 'x' }];
  const next = pushError(orig, { ts: 2, tool: 'b', message: 'y' });
  assert.equal(orig.length, 1);
  assert.equal(next.length, 2);
});

test('buildDiagnostics produce JSON leggibile con tutti i campi', () => {
  const out = buildDiagnostics({
    extensionVersion: '1.7.0',
    serverVersion: '1.7.0',
    chromeVersion: '150.0.0.0',
    state: 'connected',
    port: 8765,
    userScriptsEnabled: false,
    instrument: true,
    toolCallCount: 42,
    lastTool: 'screenshot',
    recentErrors: [{ ts: 1, tool: 'click', message: 'boom' }],
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.extension, '1.7.0');
  assert.equal(parsed.server, '1.7.0');
  assert.equal(parsed.state, 'connected');
  assert.equal(parsed.userScripts, false);
  assert.equal(parsed.toolCalls, 42);
  assert.equal(parsed.recentErrors[0].message, 'boom');
});

test('buildDiagnostics con serverVersion null → "unknown"', () => {
  const parsed = JSON.parse(buildDiagnostics({
    extensionVersion: '1.7.0', serverVersion: null, chromeVersion: 'x',
    state: 'disconnected', port: 8765, userScriptsEnabled: true, instrument: false,
    toolCallCount: 0, lastTool: null, recentErrors: [],
  }));
  assert.equal(parsed.server, 'unknown');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/telemetry.test.js`
Expected: FAIL (`Cannot find module .../extension/telemetry.js`)

- [ ] **Step 3: Write minimal implementation**

```js
// extension/telemetry.js
/**
 * Funzioni pure per la telemetria del popup: ring buffer degli errori
 * recenti e report diagnostico copiabile. Nessuna API chrome.* qui:
 * il file è importato sia dal service worker sia dai unit test Node
 * (side-effect import, export su globalThis).
 */
(() => {
  function pushError(buf, entry, max = 5) {
    const next = buf.concat([entry]);
    return next.length > max ? next.slice(next.length - max) : next;
  }

  function buildDiagnostics(d) {
    return JSON.stringify({
      extension: d.extensionVersion,
      server: d.serverVersion || 'unknown',
      chrome: d.chromeVersion,
      state: d.state,
      port: d.port,
      userScripts: d.userScriptsEnabled,
      instrument: d.instrument,
      toolCalls: d.toolCallCount,
      lastTool: d.lastTool,
      recentErrors: d.recentErrors,
    }, null, 2);
  }

  globalThis.__cbTelemetry = { pushError, buildDiagnostics };
})();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/telemetry.test.js`
Expected: PASS (4 test)

- [ ] **Step 5: Commit**

```bash
git add extension/telemetry.js test/unit/telemetry.test.js
git commit -m "feat(popup): telemetry.js — ring buffer errori e report diagnostica"
```

---

### Task 2: stack-detect.js — euristiche stack tecnologico

**Files:**
- Create: `extension/stack-detect.js`
- Test: `test/unit/stack-detect.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/stack-detect.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/stack-detect.js';

const { detectStack } = globalThis.__cbStackDetect;

// Doc finto: querySelector su mappa selettore→risultato, querySelectorAll su lista script src
function fakeDoc({ metaGenerator = null, scriptSrcs = [], hasTailwindClass = false } = {}) {
  return {
    querySelector: (sel) => {
      if (sel === 'meta[name="generator"]' && metaGenerator) return { content: metaGenerator };
      if (sel === '[class*="tw-"], .container .flex' && hasTailwindClass) return {};
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === 'script[src]') return scriptSrcs.map((src) => ({ src }));
      return [];
    },
  };
}

test('rileva React da hook devtools', () => {
  const win = { __REACT_DEVTOOLS_GLOBAL_HOOK__: {} };
  assert.ok(detectStack(win, fakeDoc()).includes('React'));
});

test('rileva Vue, jQuery con versione', () => {
  const win = { Vue: { version: '3.4.0' }, jQuery: { fn: { jquery: '3.7.1' } } };
  const out = detectStack(win, fakeDoc());
  assert.ok(out.includes('Vue'));
  assert.ok(out.includes('jQuery'));
});

test('rileva WordPress da meta generator', () => {
  const out = detectStack({}, fakeDoc({ metaGenerator: 'WordPress 6.5' }));
  assert.ok(out.includes('WordPress'));
});

test('rileva Vite da script src', () => {
  const out = detectStack({}, fakeDoc({ scriptSrcs: ['/@vite/client', '/src/main.js'] }));
  assert.ok(out.includes('Vite'));
});

test('pagina anonima → array vuoto', () => {
  assert.deepEqual(detectStack({}, fakeDoc()), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/stack-detect.test.js`
Expected: FAIL (`Cannot find module .../extension/stack-detect.js`)

- [ ] **Step 3: Write minimal implementation**

```js
// extension/stack-detect.js
/**
 * Euristiche leggere di stack detection, eseguite in MAIN world sulla tab
 * attiva quando l'utente apre il popup. Nessuna libreria esterna: solo
 * global note e indizi DOM. Best-effort dichiarato: un framework ben
 * nascosto (build minificata senza global) non viene rilevato.
 *
 * Nel browser il file viene iniettato via chrome.scripting.executeScript
 * e deposita il risultato in window.__chromeBridge_stackDetect; nei unit
 * test Node si importa per side effect e si usa globalThis.__cbStackDetect.
 */
(() => {
  function detectStack(win, doc) {
    const found = [];
    const add = (name) => { if (!found.includes(name)) found.push(name); };

    if (win.__REACT_DEVTOOLS_GLOBAL_HOOK__ || win.React) add('React');
    if (win.__NEXT_DATA__) add('Next.js');
    if (win.Vue || win.__VUE__) add('Vue');
    if (win.__NUXT__) add('Nuxt');
    if (win.ng || win.getAllAngularRootElements) add('Angular');
    if (win.__svelte || win.__SVELTE_HMR__) add('Svelte');
    if (win.Alpine) add('Alpine.js');
    if (win.jQuery || win.$?.fn?.jquery) add('jQuery');
    if (win.wp || win.wpApiSettings) add('WordPress');
    if (win.prestashop) add('PrestaShop');
    if (win.Shopify) add('Shopify');

    const gen = doc.querySelector('meta[name="generator"]');
    const genText = (gen && gen.content) || '';
    for (const [needle, name] of [
      ['WordPress', 'WordPress'], ['PrestaShop', 'PrestaShop'],
      ['Joomla', 'Joomla'], ['Drupal', 'Drupal'], ['Hugo', 'Hugo'],
      ['Gatsby', 'Gatsby'], ['Astro', 'Astro'],
    ]) {
      if (genText.includes(needle)) add(name);
    }

    for (const s of doc.querySelectorAll('script[src]')) {
      const src = s.src || '';
      if (src.includes('/@vite/')) add('Vite');
      if (src.includes('webpack')) add('webpack');
      if (src.includes('cdn.tailwindcss.com')) add('Tailwind');
    }

    return found;
  }

  globalThis.__cbStackDetect = { detectStack };

  // Esecuzione come content script: deposita il risultato per il service worker
  if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.document === document) {
    try { window.__chromeBridge_stackDetect = detectStack(window, document); } catch {}
  }
})();
```

Nota: il selettore Tailwind del test fake non è usato dall'implementazione (rilevare Tailwind da classi è troppo fragile — solo CDN src). Il fake lo prevede ma nessun assert lo richiede.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/stack-detect.test.js`
Expected: PASS (5 test)

- [ ] **Step 5: Commit**

```bash
git add extension/stack-detect.js test/unit/stack-detect.test.js
git commit -m "feat(popup): stack-detect.js — euristiche framework/CMS per Pagina corrente"
```

---

### Task 3: server — risposta ext_init_ok con versione

**Files:**
- Modify: `server/ws-manager.js` (metodo `_setupChromeClient`, ~riga 231; import in testa)
- Test: `test/unit/ws-manager.test.js` (append)

- [ ] **Step 1: Write the failing test**

Aggiungi in coda a `test/unit/ws-manager.test.js` (l'harness `connect()` è già definito nel file):

```js
test('dopo ext_init il server risponde ext_init_ok con version', async () => {
  const ws = await connect({ origin: 'chrome-extension://abcdefghijklmnop' });
  const got = new Promise((resolve) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ext_init_ok') resolve(msg);
    });
  });
  ws.send(JSON.stringify({ type: 'ext_init' }));
  const msg = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), 1000))]);
  assert.ok(msg, 'ext_init_ok non ricevuto');
  assert.match(msg.version, /^\d+\.\d+\.\d+$/);
  ws.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/ws-manager.test.js`
Expected: FAIL sul nuovo test (`ext_init_ok non ricevuto`); i test esistenti PASS.

- [ ] **Step 3: Implement**

In `server/ws-manager.js` riga 17: aggiungi `VERSION` all'import esistente da `./protocol.js`:

```js
import { DEFAULT_PORT, PING_INTERVAL_MS, IDENT_TIMEOUT_MS, PENDING_RELAY_TTL_MS, getTimeout, createCommand, MessageType, VERSION } from './protocol.js';
``` Poi in `_setupChromeClient(ws)`, subito dopo il log `'Chrome extension connected'`:

```js
    try { ws.send(JSON.stringify({ type: 'ext_init_ok', version: VERSION })); } catch {}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/unit/ws-manager.test.js`
Expected: PASS tutti (incluso il nuovo).

- [ ] **Step 5: Full unit suite (regressioni)**

Run: `npm run test:unit`
Expected: PASS (79 esistenti + nuovi).

- [ ] **Step 6: Commit**

```bash
git add server/ws-manager.js test/unit/ws-manager.test.js
git commit -m "feat(server): handshake ext_init_ok con versione server"
```

---

### Task 4: service worker — telemetria, handshake, messaggi popup

**Files:**
- Modify: `extension/service-worker.js` (import in testa; listener popup ~riga 95; `ws.onopen`/`ws.onmessage` ~righe 122-176; nuove funzioni dopo `setConnectionState` ~riga 201)

Nessun unit test (il SW usa API chrome.*): la verifica è nel Task 7. Le parti pure sono già testate (Task 1-2).

- [ ] **Step 1: Import telemetry e stato sessione**

In testa a `extension/service-worker.js` (dopo i commenti iniziali, prima delle costanti):

```js
import './telemetry.js';
const { pushError } = globalThis.__cbTelemetry;
```

Dopo la dichiarazione `let connectionState = ...` (riga ~81):

```js
let serverVersion = null;
let sessionStats = { toolCallCount: 0, lastTool: null, lastToolTs: null, recentErrors: [] };
// Il SW MV3 muore e rinasce: ripristina i contatori di sessione
chrome.storage.session.get({ sessionStats: null }).then(({ sessionStats: saved }) => {
  if (saved) sessionStats = saved;
}).catch(() => {});
function persistStats() {
  chrome.storage.session.set({ sessionStats }).catch(() => {});
}
```

- [ ] **Step 2: Handshake e contatori in ws.onmessage**

In `ws.onmessage`, dopo il blocco `if (msg.type === 'ping') {...}` e prima di `executeCommand`:

```js
    // Handshake: il server dichiara la sua versione
    if (msg.type === 'ext_init_ok') {
      serverVersion = msg.version || null;
      return;
    }

    sessionStats.toolCallCount += 1;
    sessionStats.lastTool = msg.type;
    sessionStats.lastToolTs = Date.now();
```

Nel `catch (err)` dello stesso handler, prima di `sendMessage({...type: 'error'...})`:

```js
      sessionStats.recentErrors = pushError(sessionStats.recentErrors, {
        ts: Date.now(), tool: msg.type, message: err.message || String(err),
      });
```

Dopo il try/catch (sia successo che errore), come ultima riga dell'handler:

```js
    persistStats();
```

- [ ] **Step 3: forceReconnect e getPageInfo**

Dopo `setConnectionState` (riga ~201):

```js
function forceReconnect() {
  clearTimeout(reconnectTimer);
  reconnectDelay = RECONNECT_BASE_MS;
  if (ws) {
    const s = ws;
    ws = null; // evita che l'onclose del vecchio socket pianifichi un reconnect
    try { s.close(); } catch {}
  }
  setConnectionState('disconnected');
  connect();
}

// Info sulla tab attiva per la card "Pagina corrente" del popup.
// Best-effort: ogni blocco fallisce in silenzio (pagina non iniettabile,
// instrumentation spenta) e il popup degrada di conseguenza.
async function getPageInfo() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) return { available: false };
  const target = { tabId: tab.id };

  let stack = [];
  try {
    await chrome.scripting.executeScript({ target, files: ['stack-detect.js'], world: 'MAIN' });
    const [r] = await chrome.scripting.executeScript({
      target, world: 'MAIN',
      func: () => window.__chromeBridge_stackDetect || [],
    });
    stack = r?.result || [];
  } catch {}

  let consoleErrors = null;
  let vitals = null;
  try {
    const [r] = await chrome.scripting.executeScript({
      target, world: 'MAIN',
      func: () => ({
        hooked: !!window.__chromeBridge_consoleHooked,
        errors: (window.__chromeBridge_consoleLogs || []).filter((l) => l.level === 'error').length,
        vitals: window.__chromeBridge_vitals
          ? { lcp: window.__chromeBridge_vitals.lcp, cls: Math.round((window.__chromeBridge_vitals.cls || 0) * 1000) / 1000 }
          : null,
      }),
    });
    if (r?.result?.hooked) {
      consoleErrors = r.result.errors;
      vitals = r.result.vitals;
    }
  } catch {}

  return { available: true, title: tab.title || '', stack, consoleErrors, vitals };
}
```

- [ ] **Step 4: Estendi il listener runtime.onMessage**

Sostituisci il listener esistente (righe 95-99) con:

```js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getConnectionState') {
    sendResponse({ state: connectionState });
    return;
  }
  if (msg.type === 'getPopupData') {
    (async () => {
      const cfg = await chrome.storage.local.get({ port: 8765, instrument: true });
      sendResponse({
        state: connectionState,
        port: cfg.port,
        instrument: cfg.instrument,
        extensionVersion: chrome.runtime.getManifest().version,
        serverVersion,
        stats: sessionStats,
      });
    })();
    return true; // risposta asincrona
  }
  if (msg.type === 'getPageInfo') {
    getPageInfo()
      .then(sendResponse)
      .catch((e) => sendResponse({ available: false, error: e.message }));
    return true;
  }
  if (msg.type === 'reconnect') {
    forceReconnect();
    sendResponse({ ok: true });
    return;
  }
});
```

- [ ] **Step 5: Reset serverVersion su disconnessione**

In `ws.onclose` (riga ~131), dopo `ws = null;`:

```js
    serverVersion = null;
```

- [ ] **Step 6: Syntax check + commit**

Run: `node --check extension/service-worker.js`
Expected: nessun output (sintassi ok).

```bash
git add extension/service-worker.js
git commit -m "feat(popup): SW — telemetria sessione, handshake versione, messaggi getPopupData/getPageInfo/reconnect"
```

---

### Task 5: popup.html + popup.css — nuova UI con tema auto

**Files:**
- Rewrite: `extension/popup.html`
- Rewrite: `extension/popup.css`

Riferimento visivo: mockup approvato `.superpowers/brainstorm/27088-1783949274/content/theme-auto.html` (light = Material chiaro, dark = palette GitHub-dark).

- [ ] **Step 1: Riscrivi popup.html**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <header class="hdr">
    <img src="icons/icon-48.png" alt="" class="logo">
    <h1>Chrome Bridge</h1>
    <span class="ver" id="versions">v—</span>
  </header>

  <div class="status-row">
    <span id="indicator" class="dot disconnected"></span>
    <b id="status-text">Disconnesso</b>
    <span class="ws-url" id="ws-url">ws://localhost:8765</span>
  </div>

  <div id="us-warning" class="warn" hidden>
    <b>⚠ Script utente disattivati</b>
    <span>execute_js e wait_for(function) non sono disponibili senza il permesso dedicato.</span>
    <button id="us-fix" class="fixbtn">Apri impostazioni →</button>
  </div>

  <section class="card" id="page-card">
    <div class="card-title">Pagina corrente</div>
    <div id="page-body">
      <div class="kv"><span>Errori console</span><b id="pg-errors">—</b></div>
      <div class="kv"><span>LCP / CLS</span><b id="pg-vitals">—</b></div>
      <div class="kv"><span>Stack</span><b id="pg-stack">—</b></div>
      <div class="hint" id="pg-hint" hidden>Attiva "Capture console &amp; metrics" (⚙) per errori e metriche.</div>
    </div>
    <div id="page-unavailable" hidden>Non disponibile su questa pagina.</div>
  </section>

  <div class="stats">
    <div class="stat"><div class="n" id="st-calls">0</div><div class="l">tool call</div></div>
    <div class="stat"><div class="n small" id="st-last">—</div><div class="l" id="st-last-ago">ultimo</div></div>
    <div class="stat"><div class="n" id="st-errors">0</div><div class="l">errori</div></div>
  </div>

  <div id="err-list" class="card" hidden>
    <div class="card-title">Errori recenti</div>
    <ul id="err-items"></ul>
  </div>

  <div class="acts">
    <button id="reconnect" class="abtn">↻ Riconnetti</button>
    <button id="diagnostics" class="abtn">⧉ Diagnostica</button>
    <button id="toggle-config" class="abtn icon" title="Impostazioni">⚙</button>
  </div>

  <div class="config" id="config" hidden>
    <label>Porta <input type="number" id="port" min="1" max="65535"></label>
    <label>Token <input type="password" id="token" placeholder="(nessuno)"></label>
    <label class="check"><input type="checkbox" id="instrument"> Capture console &amp; metrics</label>
    <button id="save" class="abtn primary">Salva e riconnetti</button>
  </div>

  <script src="telemetry.js"></script>
  <script src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 2: Riscrivi popup.css**

```css
* { margin: 0; padding: 0; box-sizing: border-box; }

:root {
  --bg: #ffffff;
  --fg: #1f1f1f;
  --muted: #5f6368;
  --surface: #f8f9fa;
  --border: #e0e0e0;
  --accent: #1a73e8;
  --accent-bg: #f1f3f4;
  --ok: #188038;
  --ok-bg: #e6f4ea;
  --err: #d93025;
  --warn-bg: #fef7e0;
  --warn-fg: #994c00;
  --warn-btn: #1a73e8;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --fg: #e6edf3;
    --muted: #8b949e;
    --surface: #161b22;
    --border: #21262d;
    --accent: #58a6ff;
    --accent-bg: #21262d;
    --ok: #3fb950;
    --ok-bg: #12261e;
    --err: #f85149;
    --warn-bg: #341a00;
    --warn-fg: #e3b341;
    --warn-btn: #9e6a03;
  }
}

body {
  width: 320px;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  background: var(--bg);
  color: var(--fg);
}

.hdr {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.hdr .logo { width: 22px; height: 22px; border-radius: 6px; }
.hdr h1 { font-size: 14px; font-weight: 700; }
.hdr .ver { font-size: 10px; color: var(--muted); margin-left: auto; }

.status-row { display: flex; align-items: center; gap: 6px; padding: 10px 14px; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot.connected { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
.dot.connecting { background: #f39c12; }
.dot.disconnected { background: var(--err); }
#status-text { font-weight: 600; }
.status-row .ws-url {
  margin-left: auto;
  font-family: ui-monospace, monospace;
  font-size: 11px; color: var(--muted);
}

.warn {
  margin: 0 14px 10px; padding: 10px 12px;
  border-radius: 8px; font-size: 12px; line-height: 1.45;
  background: var(--warn-bg); color: var(--warn-fg);
}
.warn b { display: block; margin-bottom: 2px; }
.fixbtn {
  margin-top: 8px; padding: 5px 12px;
  border: none; border-radius: 6px; cursor: pointer;
  font-size: 12px; font-weight: 600;
  background: var(--warn-btn); color: #fff;
}

.card {
  margin: 0 14px 10px; padding: 8px 10px;
  border-radius: 8px; background: var(--surface);
}
.card-title {
  font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
  color: var(--muted); margin-bottom: 4px;
}
.kv { display: flex; justify-content: space-between; font-size: 12px; padding: 2px 0; }
.kv span { color: var(--muted); }
.kv b.bad { color: var(--err); }
.hint { font-size: 11px; color: var(--muted); padding-top: 4px; }
#page-unavailable { font-size: 12px; color: var(--muted); }

.stats { display: flex; gap: 8px; padding: 0 14px 10px; }
.stat { flex: 1; border-radius: 8px; padding: 8px 10px; background: var(--surface); }
.stat .n { font-size: 16px; font-weight: 700; font-family: ui-monospace, monospace; }
.stat .n.small { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stat .n.bad { color: var(--err); }
.stat .l { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }

#err-items { list-style: none; font-size: 11px; }
#err-items li { padding: 2px 0; color: var(--muted); }
#err-items li b { color: var(--err); font-family: ui-monospace, monospace; }

.acts { display: flex; gap: 8px; padding: 0 14px 14px; }
.abtn {
  flex: 1; padding: 7px 0; text-align: center;
  border: none; border-radius: 8px; cursor: pointer;
  font-size: 12px; font-weight: 600;
  background: var(--accent-bg); color: var(--accent);
}
.abtn.icon { flex: 0 0 36px; }
.abtn.primary { background: var(--accent); color: #fff; }
.abtn:hover { filter: brightness(0.95); }

.config {
  display: flex; flex-direction: column; gap: 6px;
  margin: 0 14px 14px; padding: 10px;
  border-radius: 8px; background: var(--surface); font-size: 12px;
}
.config input {
  width: 100%; padding: 4px 6px;
  border: 1px solid var(--border); border-radius: 4px;
  background: var(--bg); color: var(--fg);
}
.config label.check { display: flex; align-items: center; gap: 6px; }
.config label.check input { width: auto; }
```

- [ ] **Step 3: Commit**

```bash
git add extension/popup.html extension/popup.css
git commit -m "feat(popup): nuova UI 320px con tema auto dark/light"
```

---

### Task 6: popup.js — logica

**Files:**
- Rewrite: `extension/popup.js`

- [ ] **Step 1: Riscrivi popup.js**

```js
const $ = (id) => document.getElementById(id);

const stateLabels = {
  connected: 'Connesso',
  connecting: 'Connessione…',
  disconnected: 'Disconnesso',
};

function renderState(state) {
  $('indicator').className = `dot ${state}`;
  $('status-text').textContent = stateLabels[state] || state;
}

function agoLabel(ts) {
  if (!ts) return 'ultimo';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `ultimo · ${s}s fa`;
  if (s < 3600) return `ultimo · ${Math.round(s / 60)}m fa`;
  return `ultimo · ${Math.round(s / 3600)}h fa`;
}

let lastData = null;

function renderPopupData(d) {
  lastData = d;
  renderState(d.state);
  $('ws-url').textContent = `ws://localhost:${d.port}`;
  $('versions').textContent = d.serverVersion
    ? `ext ${d.extensionVersion} · srv ${d.serverVersion}`
    : `v${d.extensionVersion}`;

  const st = d.stats || { toolCallCount: 0, lastTool: null, lastToolTs: null, recentErrors: [] };
  $('st-calls').textContent = st.toolCallCount;
  $('st-last').textContent = st.lastTool || '—';
  $('st-last-ago').textContent = agoLabel(st.lastToolTs);
  $('st-errors').textContent = st.recentErrors.length;
  $('st-errors').classList.toggle('bad', st.recentErrors.length > 0);

  const errList = $('err-list');
  if (st.recentErrors.length) {
    errList.hidden = false;
    $('err-items').replaceChildren(...st.recentErrors.slice().reverse().map((e) => {
      const li = document.createElement('li');
      const tool = document.createElement('b');
      tool.textContent = e.tool;
      li.append(tool, ` ${new Date(e.ts).toLocaleTimeString()} — ${e.message}`);
      return li;
    }));
  } else {
    errList.hidden = true;
  }
}

function renderPageInfo(info) {
  const body = $('page-body');
  const unavailable = $('page-unavailable');
  if (!info || !info.available) {
    body.hidden = true;
    unavailable.hidden = false;
    return;
  }
  body.hidden = false;
  unavailable.hidden = true;

  const hasInstrument = info.consoleErrors !== null;
  $('pg-hint').hidden = hasInstrument;
  if (hasInstrument) {
    $('pg-errors').textContent = info.consoleErrors;
    $('pg-errors').classList.toggle('bad', info.consoleErrors > 0);
    $('pg-vitals').textContent = info.vitals
      ? `${info.vitals.lcp != null ? (info.vitals.lcp / 1000).toFixed(1) + 's' : '—'} · ${info.vitals.cls}`
      : '—';
  } else {
    $('pg-errors').textContent = '—';
    $('pg-vitals').textContent = '—';
  }
  $('pg-stack').textContent = info.stack?.length ? info.stack.join(' · ') : '—';
}

// --- Caricamento iniziale ---
chrome.runtime.sendMessage({ type: 'getPopupData' }, (d) => { if (d) renderPopupData(d); });
chrome.runtime.sendMessage({ type: 'getPageInfo' }, (info) => renderPageInfo(info));

// Stato live mentre il popup è aperto
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'connectionState') renderState(msg.state);
});

// --- Warning userScripts ---
let userScriptsEnabled = true;
try {
  chrome.userScripts.getScripts;
} catch {
  userScriptsEnabled = false;
  $('us-warning').hidden = false;
}
$('us-fix').addEventListener('click', () => {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

// --- Azioni ---
$('reconnect').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'reconnect' }, () => {});
});

$('diagnostics').addEventListener('click', async () => {
  const d = lastData || {};
  const report = globalThis.__cbTelemetry.buildDiagnostics({
    extensionVersion: d.extensionVersion || chrome.runtime.getManifest().version,
    serverVersion: d.serverVersion || null,
    chromeVersion: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || 'unknown',
    state: d.state || 'unknown',
    port: d.port || null,
    userScriptsEnabled,
    instrument: d.instrument ?? null,
    toolCallCount: d.stats?.toolCallCount ?? 0,
    lastTool: d.stats?.lastTool ?? null,
    recentErrors: d.stats?.recentErrors ?? [],
  });
  await navigator.clipboard.writeText(report);
  $('diagnostics').textContent = '✓ Copiato';
  setTimeout(() => { $('diagnostics').textContent = '⧉ Diagnostica'; }, 1500);
});

// --- Config (collassata dietro ⚙) ---
$('toggle-config').addEventListener('click', () => {
  $('config').hidden = !$('config').hidden;
});

chrome.storage.local.get({ port: 8765, token: '', instrument: true }, (cfg) => {
  $('port').value = cfg.port;
  $('token').value = cfg.token;
  $('instrument').checked = cfg.instrument;
});

$('save').addEventListener('click', () => {
  const p = parseInt($('port').value, 10);
  const port = (p >= 1 && p <= 65535) ? p : 8765;
  chrome.storage.local.set({ port, token: $('token').value.trim(), instrument: $('instrument').checked });
  $('ws-url').textContent = `ws://localhost:${port}`;
  chrome.runtime.sendMessage({ type: 'reconnect' }, () => {});
});
```

Nota: il vecchio popup.js salvava la config senza riconnettere ("Save & Reconnect" era solo label — il SW rileggeva la porta al reconnect successivo). Ora il salvataggio invia davvero `reconnect`.

- [ ] **Step 2: Syntax check + commit**

Run: `node --check extension/popup.js`
Expected: nessun output.

```bash
git add extension/popup.js
git commit -m "feat(popup): logica popup — dati live, pagina corrente, azioni"
```

---

### Task 7: verifica end-to-end

**Files:** nessuno (verifica manuale + chrome-bridge).

- [ ] **Step 1: Ricarica l'extension unpacked nel Chromium del container**

```bash
pkill -x chromium; sleep 2
nohup /usr/bin/chromium --load-extension=/home/franz/Desktop/workspaces/chrome-bridge/extension \
  --no-first-run --hide-crash-restore-bubble --remote-debugging-port=9222 >/dev/null 2>&1 &
sleep 6 && curl -s http://localhost:9222/json/version | head -2
```

Expected: JSON con "Browser": "Chrome/...". (Il SW ricompilato si connette al server già attivo su 8765.)

- [ ] **Step 2: Verifica connessione e telemetria**

Con i tool MCP chrome-bridge: `get_status` → connected true. Esegui 2-3 tool (`get_tabs`, `navigate` su example.com, `screenshot`) per popolare i contatori.

- [ ] **Step 3: Screenshot popup light/dark**

Il popup è una pagina extension: aprirla come tab per lo screenshot CDP:
`chrome-extension://<ID>/popup.html` (ID dell'unpacked: leggilo da chrome://extensions o via CDP `/json` cercando il target service worker). Screenshot con il helper CDP della sessione (`cdp.js <targetId> shot popup-light.png`). Per il dark: rilancia chromium aggiungendo `--force-dark-mode --enable-features=WebContentsForceDark` oppure verifica il blocco `@media (prefers-color-scheme: dark)` con CDP `Emulation.setEmulatedMedia`.

Checklist visiva (confronta col mockup theme-auto.html):
- header con versioni ext+srv
- stato verde "Connesso" con endpoint
- card Pagina corrente con stack rilevato (su una pagina reale tipo github.com: "React")
- contatori tool call > 0, ultimo tool corretto
- warning userScripts visibile (unpacked senza toggle) con bottone
- ⚙ apre/chiude config; Salva riconnette (pallino passa per "Connessione…")

- [ ] **Step 4: Verifica degradazioni**

- Tab `chrome://newtab` attiva → card mostra "Non disponibile su questa pagina"
- Toggle instrument OFF (⚙) → riga hint al posto di errori/vitals, stack ancora presente
- Kill del server (`pkill -f 'chrome-bridge/server/index.js'` SOLO se avviato ad hoc — in sessione con server condiviso salta questo punto) → stato rosso, contatori restano

- [ ] **Step 5: Suite completa**

Run: `npm run test:unit`
Expected: PASS tutti.

---

### Task 8: versioning e pacchetto

**Files:**
- Modify: `extension/manifest.json:4` (version)
- Modify: `package.json:3` (version)
- Modify: `server/protocol.js:83` (VERSION)
- Modify: `CHANGELOG.md` (nuova sezione in testa)

- [ ] **Step 1: Bump 1.7.0**

- `extension/manifest.json`: `"version": "1.7.0"`
- `package.json`: `"version": "1.7.0"`
- `server/protocol.js`: `export const VERSION = '1.7.0';`

- [ ] **Step 2: CHANGELOG**

Aggiungi in testa a `CHANGELOG.md` (rispetta il formato delle sezioni esistenti):

```markdown
## 1.7.0 — 2026-07-13

### Popup ridisegnato
- Tema automatico dark/light (prefers-color-scheme)
- Warning "Allow user scripts" prominente con fix 1-click (apre chrome://extensions)
- Card "Pagina corrente": errori console, LCP/CLS, stack tecnologico euristico
- Telemetria sessione: contatore tool call, ultimo tool, ultimi 5 errori
- Azioni: riconnetti, copia report diagnostica; config collassata dietro ⚙

### Server
- Handshake `ext_init_ok` con versione server (mostrata nel popup)
```

- [ ] **Step 3: Zip e verifica contenuto**

Run: `bash scripts/package-extension.sh`
Expected: `dist/chrome-bridge-extension-1.7.0.zip` con `telemetry.js` e `stack-detect.js` nel listing.

- [ ] **Step 4: Commit**

```bash
git add extension/manifest.json package.json server/protocol.js CHANGELOG.md
git commit -m "chore: release 1.7.0 — popup redesign"
```

- [ ] **Step 5: Upload CWS (opzionale, su conferma utente)**

Procedura in memoria `webstore-cdp-workaround`: Chromium con `--remote-debugging-port=9222`, dashboard → Pacchetto → Carica nuovo pacchetto → Invia per revisione. NON inviare senza conferma esplicita dell'utente (1.6.0 potrebbe essere ancora in revisione: CWS rifiuta una seconda submission pendente — in quel caso aspettare).
