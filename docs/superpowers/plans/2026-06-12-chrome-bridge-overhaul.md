# Chrome Bridge Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hardening sicurezza, fix di 11 bug, miglioramenti UX e 8 nuovi tool MCP per chrome-bridge (31 → 39 tool).

**Architecture:** MCP server Node (stdio) ↔ WebSocket :8765 ↔ Chrome extension MV3. Il server resta in `server/` (protocol.js = costanti, ws-manager.js = trasporto, tools.js = registrazione MCP), l'estensione in `extension/` (service-worker.js = dispatcher comandi). Nuovi file: `server/link-checker.js`, `extension/console-capture.js`, `test/unit/*.test.js`.

**Tech Stack:** Node ≥18 (qui 24), `ws`, `@modelcontextprotocol/sdk`, Zod, Chrome MV3 (`chrome.scripting`, `chrome.cookies`, `chrome.webNavigation`, `chrome.webRequest`, OffscreenCanvas). Test: `node:test` builtin.

**Vincoli di verifica:** il codice estensione NON è testabile senza Chrome. Strategia: TDD con `node:test` per tutto il codice server; per l'estensione, verifica e2e finale (Task 18) con estensione ricaricata manualmente. Ogni task committa da solo.

**Convenzione commit:** Conventional Commits, footer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 0: Commit del lavoro relay pendente

**Files:** nessuna modifica, solo commit di `README.md`, `package.json`, `server/index.js`, `server/ws-manager.js` (già modificati nel working tree).

- [ ] **Step 1: Verifica diff pendente**

Run: `git -C /home/franz/Desktop/workspaces/chrome-bridge status --short`
Expected: 4 file `M` (README.md, package.json, server/index.js, server/ws-manager.js)

- [ ] **Step 2: Commit**

```bash
git add README.md package.json server/index.js server/ws-manager.js
git commit -m "feat: relay mode for multiple MCP instances sharing one extension"
```

---

### Task 1: Handshake di identificazione obbligatorio (sicurezza)

Oggi qualsiasi connessione WS anonima diventa "Chrome client" dopo 5s e sostituisce l'estensione vera (`ws-manager.js:197-203`). Fix: primo messaggio obbligatorio `ext_init` (con check header Origin + token opzionale) o `relay_init` (solo loopback); altrimenti terminate. Il timer di identificazione va cancellato su close/identificazione.

**Files:**
- Modify: `server/protocol.js`
- Modify: `server/ws-manager.js`
- Modify: `extension/service-worker.js` (onopen invia ext_init)
- Modify: `test/test-devtools.js` (il server di test deve ignorare/accettare il messaggio `ext_init` dell'estensione)
- Create: `test/unit/ws-manager.test.js`
- Modify: `package.json` (script `test:unit`)

- [ ] **Step 1: Aggiungi costanti a protocol.js**

In `server/protocol.js` dopo `PONG: 'pong',` dentro `MessageType` aggiungi:

```js
  // Handshake identificazione connessione
  EXT_INIT:   'ext_init',
  RELAY_INIT: 'relay_init',
```

E dopo le costanti di configurazione:

```js
export const IDENT_TIMEOUT_MS = 5000;   // tempo max per identificarsi
```

- [ ] **Step 2: Scrivi i test che falliscono** (`test/unit/ws-manager.test.js`)

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { WSManager } from '../../server/ws-manager.js';

let manager;
let port;

before(async () => {
  manager = new WSManager(0, { identTimeout: 200 });
  await manager.start();
  port = manager.wss.address().port;
});

after(async () => {
  await manager.stop();
});

function connect(headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitClose(ws, ms = 1000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    ws.on('close', () => { clearTimeout(t); resolve(true); });
  });
}

test('connessione muta viene terminata dopo identTimeout', async () => {
  const ws = await connect();
  const closed = await waitClose(ws);
  assert.equal(closed, true);
  assert.equal(manager.isConnected(), false);
});

test('primo messaggio sconosciuto → terminate', async () => {
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'pong' }));
  const closed = await waitClose(ws);
  assert.equal(closed, true);
});

test('ext_init con Origin non-extension → terminate', async () => {
  const ws = await connect({ origin: 'http://evil.example' });
  ws.send(JSON.stringify({ type: 'ext_init' }));
  const closed = await waitClose(ws);
  assert.equal(closed, true);
  assert.equal(manager.isConnected(), false);
});

test('ext_init con Origin chrome-extension:// → accettato', async () => {
  const ws = await connect({ origin: 'chrome-extension://abcdefghijklmnop' });
  ws.send(JSON.stringify({ type: 'ext_init' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(manager.isConnected(), true);
  ws.close();
  await new Promise((r) => setTimeout(r, 100));
});

test('ext_init con token sbagliato quando CHROME_BRIDGE_TOKEN impostato → terminate', async () => {
  const m2 = new WSManager(0, { identTimeout: 200, token: 'secret' });
  await m2.start();
  const p2 = m2.wss.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${p2}`, { headers: { origin: 'chrome-extension://abc' } });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'ext_init', token: 'wrong' }));
  const closed = await waitClose(ws);
  assert.equal(closed, true);
  assert.equal(m2.isConnected(), false);
  await m2.stop();
});

test('relay_init da loopback → accettato come relay', async () => {
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'relay_init' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(manager.relayClients.size, 1);
  ws.close();
  await new Promise((r) => setTimeout(r, 100));
});
```

- [ ] **Step 3: Aggiungi script test e verifica che fallisca**

In `package.json` scripts: `"test:unit": "node --test test/unit/"`.

Run: `npm run test:unit`
Expected: FAIL (`identTimeout` non supportato, connessione muta diventa chrome client)

- [ ] **Step 4: Implementa in ws-manager.js**

Costruttore — accetta opts:

```js
constructor(port = DEFAULT_PORT, opts = {}) {
  this.port = port;
  this.identTimeout = opts.identTimeout ?? IDENT_TIMEOUT_MS;
  this.token = opts.token ?? process.env.CHROME_BRIDGE_TOKEN ?? null;
  // ...resto invariato
}
```

Import: aggiungi `IDENT_TIMEOUT_MS` e usa `MessageType.EXT_INIT` / `MessageType.RELAY_INIT` (elimina la costante locale `RELAY_INIT`).

`_startPrimary`: passa anche `req`:

```js
this.wss.on('connection', (ws, req) => {
  this._handleNewConnection(ws, req);
});
```

Sostituisci interamente `_handleNewConnection`:

```js
/**
 * Ogni connessione DEVE identificarsi col primo messaggio:
 * - { type: 'ext_init', token? }  → estensione Chrome (Origin chrome-extension://)
 * - { type: 'relay_init' }        → relay client (solo loopback)
 * Connessioni mute o non valide vengono terminate.
 */
_handleNewConnection(ws, req) {
  const origin = req.headers.origin || '';
  const remote = req.socket.remoteAddress || '';
  const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  let identified = false;

  const idTimer = setTimeout(() => {
    if (!identified) {
      console.error(`[chrome-bridge] Unidentified connection from ${remote} — terminating`);
      ws.terminate();
    }
  }, this.identTimeout);

  const onFirstMessage = (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      clearTimeout(idTimer);
      ws.terminate();
      return;
    }

    identified = true;
    clearTimeout(idTimer);
    ws.removeListener('message', onFirstMessage);

    if (msg.type === MessageType.RELAY_INIT) {
      if (!isLoopback) {
        console.error(`[chrome-bridge] relay_init from non-loopback ${remote} — rejected`);
        ws.terminate();
        return;
      }
      this._setupRelayClient(ws);
      return;
    }

    if (msg.type === MessageType.EXT_INIT) {
      if (origin && !origin.startsWith('chrome-extension://')) {
        console.error(`[chrome-bridge] ext_init with origin ${origin} — rejected`);
        ws.terminate();
        return;
      }
      if (this.token && msg.token !== this.token) {
        console.error('[chrome-bridge] ext_init with invalid token — rejected');
        ws.terminate();
        return;
      }
      this._setupChromeClient(ws);
      return;
    }

    console.error(`[chrome-bridge] Unexpected first message type "${msg.type}" — rejected`);
    ws.terminate();
  };

  ws.on('message', onFirstMessage);
  ws.on('close', () => clearTimeout(idTimer));
}
```

In `_startRelay`, il messaggio di init usa la costante: `this.relaySocket.send(JSON.stringify({ type: MessageType.RELAY_INIT }));`

- [ ] **Step 5: Estensione invia ext_init**

In `extension/service-worker.js`, `ws.onopen`:

```js
ws.onopen = () => {
  console.log('[chrome-bridge] Connected to MCP server');
  ws.send(JSON.stringify({ type: 'ext_init' }));
  setConnectionState('connected');
  reconnectDelay = RECONNECT_BASE_MS;
};
```

(Il token configurabile arriva nel Task 7; qui basta il type.)

- [ ] **Step 6: Adatta test/test-devtools.js**

Leggi il file: il server WS di test riceve ora `ext_init` come primo messaggio dall'estensione. Nel suo handler messaggi, ignora i messaggi `{type:'ext_init'}` e `{type:'pong'}` se non già gestiti (aggiungi early-return).

- [ ] **Step 7: Esegui unit test**

Run: `npm run test:unit`
Expected: PASS (6 test)

- [ ] **Step 8: Commit**

```bash
git add server/protocol.js server/ws-manager.js extension/service-worker.js test/ package.json
git commit -m "feat: mandatory connection handshake with origin/token validation

Any anonymous WS connection could previously replace the real Chrome
extension after 5s and receive browser commands. Now every connection
must identify with ext_init (origin chrome-extension://, optional
CHROME_BRIDGE_TOKEN) or relay_init (loopback only)."
```

---

### Task 2: Cleanup manifest + ID comando univoci

**Files:**
- Modify: `extension/manifest.json` (rimuovi `debugger` e `activeTab`, mai usati)
- Modify: `server/protocol.js` (ID con random per evitare collisioni tra istanze relay)
- Create: `test/unit/protocol.test.js`

- [ ] **Step 1: Test ID univoci**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommand } from '../../server/protocol.js';

test('createCommand genera id univoci e con entropia di istanza', () => {
  const a = createCommand('navigate');
  const b = createCommand('navigate');
  assert.notEqual(a.id, b.id);
  // formato msg_<hex8>_<counter>
  assert.match(a.id, /^msg_[0-9a-f]{8}_\d+$/);
});
```

Run: `npm run test:unit` → Expected: FAIL (formato attuale `msg_<n>_<timestamp>`)

- [ ] **Step 2: Implementa in protocol.js**

```js
import { randomBytes } from 'node:crypto';

const instanceId = randomBytes(4).toString('hex');
let messageCounter = 0;

export function createCommand(type, params = {}) {
  messageCounter += 1;
  return {
    id: `msg_${instanceId}_${messageCounter}`,
    type,
    params,
    timestamp: Date.now(),
  };
}
```

Run: `npm run test:unit` → Expected: PASS

- [ ] **Step 3: Manifest — rimuovi permessi inutilizzati**

In `extension/manifest.json` `permissions` diventa:

```json
"permissions": [
  "tabs",
  "scripting",
  "alarms"
],
```

(`debugger` mai usato — il README stesso lo dice; `activeTab` ridondante con `tabs` + `host_permissions: <all_urls>`.)

- [ ] **Step 4: Sistemazione cosmetica protocol.js**

Allinea `TYPE_TEXT: 'type_text',` (indentazione) e `PING_INTERVAL_MS` (spazi).

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json server/protocol.js test/unit/protocol.test.js
git commit -m "fix: unique command ids across relay instances; drop unused permissions"
```

---

### Task 3: Robustezza ws-manager (pong tracking, TTL pendingRelay, stop flag)

**Files:**
- Modify: `server/ws-manager.js`
- Modify: `test/unit/ws-manager.test.js` (nuovi test)

- [ ] **Step 1: Test che falliscono** (aggiungi a `test/unit/ws-manager.test.js`)

```js
test('client che non risponde ai ping viene terminato', async () => {
  const m = new WSManager(0, { identTimeout: 200, pingInterval: 100, pongGrace: 250 });
  await m.start();
  const p = m.wss.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${p}`, { headers: { origin: 'chrome-extension://abc' } });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'ext_init' }));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(m.isConnected(), true);
  // non rispondiamo mai ai ping → entro pingInterval*N + grace deve scollegare
  const closed = await waitClose(ws, 2000);
  assert.equal(closed, true);
  await m.stop();
});

test('stop() impedisce promozione successiva', async () => {
  const m = new WSManager(0, { identTimeout: 200 });
  await m.start();
  await m.stop();
  assert.equal(m.stopped, true);
  await m._promoteToPrimary(); // deve essere no-op
  assert.equal(m.wss === null || m.wss.address?.() === null || m.mode !== 'primary' || true, true);
});
```

Nota per il secondo test: dopo `stop()`, `_promoteToPrimary()` deve ritornare subito senza bindare. Assert pratico: dopo la chiamata, `m.pingInterval === null` e nessun nuovo server in ascolto sulla vecchia porta (riconnessione a `ws://127.0.0.1:<porta>` fallisce).

Run: `npm run test:unit` → Expected: FAIL

- [ ] **Step 2: Implementa**

Costruttore — aggiungi opzioni e stato:

```js
this.pingIntervalMs = opts.pingInterval ?? PING_INTERVAL_MS;
this.pongGrace = opts.pongGrace ?? 10000;
this.lastPong = 0;
this.stopped = false;
```

`_setupChromeClient`: subito dopo `this.client = ws;` aggiungi `this.lastPong = Date.now();`. Inoltre, quando sostituisce un client esistente, rigetta i pending locali del vecchio: prima di `this.client = ws` chiama `this._rejectAllPending('Replaced by new extension connection')`.

`_handleChromeMessage`, ramo PONG:

```js
if (msg.type === MessageType.PONG) {
  this.lastPong = Date.now();
  return;
}
```

`_startPing` — usa `this.pingIntervalMs`, rileva half-open, fa sweep TTL dei pendingRelay:

```js
_startPing() {
  this.pingInterval = setInterval(() => {
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      // Half-open detection: nessun pong da troppo tempo → terminate
      if (this.lastPong && Date.now() - this.lastPong > this.pingIntervalMs * 2 + this.pongGrace) {
        console.error('[chrome-bridge] Extension unresponsive (no pong) — terminating connection');
        this.client.terminate();
        return;
      }
      this.client.send(JSON.stringify({ type: MessageType.PING, timestamp: Date.now() }));
    }
    // Sweep pendingRelay scaduti (entry più vecchie di 120s)
    const cutoff = Date.now() - 120000;
    for (const [id, entry] of this.pendingRelay) {
      if (entry.ts < cutoff) this.pendingRelay.delete(id);
    }
  }, this.pingIntervalMs);
}
```

`pendingRelay` ora contiene `{ ws, ts }` — aggiorna i tre punti d'uso:
- `_setupRelayClient` message handler: `this.pendingRelay.set(msg.id, { ws, ts: Date.now() });`
- `_setupRelayClient` close handler: `if (entry.ws === ws) this.pendingRelay.delete(id);`
- `_handleChromeMessage`: `const entry = this.pendingRelay.get(msg.id); if (entry) { this.pendingRelay.delete(msg.id); if (entry.ws.readyState === WebSocket.OPEN) entry.ws.send(JSON.stringify(msg)); return; }`
- `_setupChromeClient` close handler (notifica relay): itera `for (const [id, entry] of this.pendingRelay)` e usa `entry.ws`.

`stop()`: prima riga `this.stopped = true;`.

`_promoteToPrimary()`: prima riga `if (this.stopped) return;` e dentro il loop, dopo l'`await` del delay: `if (this.stopped) return;`.

Nota: il test di half-open richiede che il client `ws` Node NON risponda ai ping JSON — di default non lo fa (il pong del protocollo WS è un'altra cosa), quindi funziona.

- [ ] **Step 3: Esegui test**

Run: `npm run test:unit` → Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/ws-manager.js test/unit/ws-manager.test.js
git commit -m "fix: half-open detection via pong tracking, pendingRelay TTL, stop flag"
```

---

### Task 4: check_links lato server (fix CORS)

`fetch no-cors` dalla pagina rende invisibili gli errori HTTP cross-origin (status sempre 0, `broken` mai true). Fix: l'estensione raccoglie solo i link, il fetch lo fa Node.

**Files:**
- Create: `server/link-checker.js`
- Create: `test/unit/link-checker.test.js`
- Modify: `server/protocol.js` (`COLLECT_LINKS`, rimuovi `CHECK_LINKS` e il suo timeout 120s)
- Modify: `server/tools.js` (tool check_links riscrittura)
- Modify: `extension/service-worker.js` (sostituisci `cmdCheckLinks` con `cmdCollectLinks`)

- [ ] **Step 1: Test link-checker** (`test/unit/link-checker.test.js`)

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { checkLinksBatch } from '../../server/link-checker.js';

let server;
let base;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok') { res.writeHead(200); res.end('ok'); return; }
    if (req.url === '/missing') { res.writeHead(404); res.end(); return; }
    if (req.url === '/no-head') {
      if (req.method === 'HEAD') { res.writeHead(405); res.end(); return; }
      res.writeHead(200); res.end('ok'); return;
    }
    res.writeHead(500); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('rileva 200, 404 e fallback GET su HEAD 405', async () => {
  const results = await checkLinksBatch([
    { url: `${base}/ok`, text: 'ok' },
    { url: `${base}/missing`, text: 'missing' },
    { url: `${base}/no-head`, text: 'nohead' },
  ], 2000);
  assert.equal(results[0].broken, false);
  assert.equal(results[0].status, 200);
  assert.equal(results[1].broken, true);
  assert.equal(results[1].status, 404);
  assert.equal(results[2].broken, false);
  assert.equal(results[2].status, 200);
});

test('errore di rete → broken con error', async () => {
  const results = await checkLinksBatch([{ url: 'http://127.0.0.1:1/x', text: 'dead' }], 1000);
  assert.equal(results[0].broken, true);
  assert.ok(results[0].error);
});
```

Run: `npm run test:unit` → Expected: FAIL (modulo inesistente)

- [ ] **Step 2: Implementa `server/link-checker.js`**

```js
/**
 * Verifica HTTP dei link lato server (niente limiti CORS della pagina).
 * HEAD con fallback GET per server che non supportano HEAD.
 */

async function checkOne({ url, text }, timeoutMs) {
  let lastError = null;
  for (const method of ['HEAD', 'GET']) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { method, redirect: 'follow', signal: ctrl.signal });
      clearTimeout(timer);
      if (method === 'HEAD' && (resp.status === 405 || resp.status === 501)) continue;
      return { url, text, status: resp.status, ok: resp.ok, broken: resp.status >= 400 };
    } catch (err) {
      clearTimeout(timer);
      lastError = err.cause?.message || err.message || 'Network error';
    }
  }
  return { url, text, status: 0, ok: false, broken: true, error: lastError };
}

export async function checkLinksBatch(links, timeoutMs = 5000, concurrency = 10) {
  const results = new Array(links.length);
  let next = 0;
  async function worker() {
    while (next < links.length) {
      const idx = next++;
      results[idx] = await checkOne(links[idx], timeoutMs);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, links.length) }, worker);
  await Promise.all(workers);
  return results;
}
```

Run: `npm run test:unit` → Expected: PASS

- [ ] **Step 3: Protocol — sostituisci tipo messaggio**

In `protocol.js`: sostituisci `CHECK_LINKS: 'check_links',` con `COLLECT_LINKS: 'collect_links',`. In `getTimeout`, togli `CHECK_LINKS` dal ramo 120s (resta solo `FULL_PAGE_SCREENSHOT`).

- [ ] **Step 4: service-worker — sostituisci comando**

Rimuovi `cmdCheckLinks` e il case `'check_links'`. Aggiungi case `'collect_links'` → `cmdCollectLinks(params)`:

```js
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
```

- [ ] **Step 5: tools.js — riscrivi check_links**

Import in testa: `import { checkLinksBatch } from './link-checker.js';`

```js
server.tool(
  'check_links',
  'Check links on the page for broken URLs. Links are collected in the page, then verified server-side (no CORS limits, real HTTP status for external links too).',
  {
    scope: z.enum(['same-origin', 'all', 'external']).optional().default('all').describe('Link scope'),
    selector: z.string().optional().default('a[href]').describe('CSS selector to find links'),
    timeout: z.number().optional().default(5000).describe('Per-link fetch timeout in ms'),
    max_links: z.number().optional().default(50).describe('Max links to check'),
    tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
  },
  async ({ scope, selector, timeout, max_links, tab_id }) => {
    const data = await wsManager.sendCommand(MessageType.COLLECT_LINKS, { scope, selector, max_links, tab_id });
    const results = await checkLinksBatch(data.links, timeout);
    const broken = results.filter((r) => r.broken).length;
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ total: data.links.length, checked: results.length, broken, results }, null, 2),
      }],
    };
  }
);
```

- [ ] **Step 6: Esegui test e commit**

Run: `npm run test:unit` → Expected: PASS

```bash
git add server/ test/unit/link-checker.test.js extension/service-worker.js
git commit -m "fix: check_links verifies HTTP status server-side

no-cors page fetch returned opaque responses (status 0), so broken
external links were never detected. Extension now only collects links;
Node does HEAD/GET with timeout and concurrency 10."
```

---

### Task 5: Batch bugfix service-worker

Sei fix indipendenti, un commit ciascuno. Nessun test automatico possibile (codice extension) — verifica nel Task 18.

**Files:** Modify: `extension/service-worker.js`, `server/tools.js`

- [ ] **Step 1: Quota captureVisibleTab** — in `cmdFullPageScreenshot` firma `{ max_scrolls = 20, delay = 500, tab_id }` e dopo: `const safeDelay = Math.max(delay, 500);` usato nel loop (`setTimeout(r, safeDelay)`). In `tools.js` il default del param `delay` diventa `500` con describe `'Delay between captures in ms (min 500, Chrome quota is 2 captures/sec)'`. Commit: `fix: clamp full_page_screenshot delay to 500ms (captureVisibleTab quota)`

- [ ] **Step 2: Alarm clamp** — riga 21: `chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }); // 30s = minimo Chrome`. Commit: `fix: use 30s keepalive alarm (Chrome minimum, 0.4 was clamped with warning)`

- [ ] **Step 3: Race navigate** — in `cmdNavigate`, registra il listener PRIMA di `tabs.update`:

```js
async function cmdNavigate({ url, tab_id }) {
  if (!url) throw new Error('Missing required parameter: url');
  const tabId = await resolveTabId(tab_id);

  const waitComplete = new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
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

  await chrome.tabs.update(tabId, { url });
  await waitComplete;

  const updatedTab = await chrome.tabs.get(tabId);
  return { url: updatedTab.url, title: updatedTab.title, tabId };
}
```

Commit: `fix: register navigation listener before tabs.update to avoid missed complete event`

- [ ] **Step 4: emulate_media MQL stub** — in `cmdEmulateMedia`, il `window.matchMedia` override deve restituire oggetti con i metodi del MediaQueryList (lo spread `{...result}` li perde → TypeError nelle pagine che chiamano `addEventListener`). Sostituisci il blocco override con:

```js
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
```

Commit: `fix: emulate_media matchMedia override returns MQL-compatible stub`

- [ ] **Step 5: press_key code map** — in `cmdPressKey` func, sostituisci il calcolo di `code`:

```js
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
  // ...resto invariato
};
```

Commit: `fix: correct KeyboardEvent.code for digits, space and punctuation`

- [ ] **Step 6: type_text React-compatible** — allinea a fill_form (native value setter):

```js
func: (sel, txt) => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`Element not found: ${sel}`);
  el.focus();
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, txt); else el.value = txt;
  } else if (el.isContentEditable) {
    el.textContent = txt;
  } else {
    el.value = txt;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { typed: true, tagName: tag };
},
```

Commit: `fix: type_text uses native value setter (React-compatible) + contenteditable support`

---

### Task 6: Porta/token configurabili nell'estensione

Il server legge `CHROME_BRIDGE_PORT` ma l'estensione ha `ws://localhost:8765` hardcoded.

**Files:**
- Modify: `extension/manifest.json` (+`storage` permission)
- Modify: `extension/service-worker.js`
- Modify: `extension/popup.html`, `extension/popup.js`, `extension/popup.css`

- [ ] **Step 1: Manifest** — aggiungi `"storage"` a `permissions`.

- [ ] **Step 2: service-worker config-aware**

In testa, sostituisci `const WS_URL = ...` con:

```js
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
      if (ws) { try { ws.close(); } catch {} } else { connect(); }
      // onclose → scheduleReconnect → connect() con nuovo URL
    });
  }
});
```

In `connect()`: `ws = new WebSocket(wsUrl);` e in `onopen` il messaggio init diventa:

```js
const init = { type: 'ext_init' };
if (extToken) init.token = extToken;
ws.send(JSON.stringify(init));
```

In fondo al file, sostituisci `connect();` con:

```js
loadConfig().then(connect);
```

- [ ] **Step 3: Popup con campo porta/token**

`popup.html` — dentro il body, dopo lo status, aggiungi:

```html
<div class="config">
  <label>Port <input type="number" id="port" min="1" max="65535"></label>
  <label>Token <input type="password" id="token" placeholder="(none)"></label>
  <button id="save">Save & Reconnect</button>
</div>
```

`popup.js` — aggiungi in fondo:

```js
const portInput = document.getElementById('port');
const tokenInput = document.getElementById('token');
chrome.storage.local.get({ port: 8765, token: '' }, (cfg) => {
  portInput.value = cfg.port;
  tokenInput.value = cfg.token;
});
document.getElementById('save').addEventListener('click', () => {
  chrome.storage.local.set({ port: parseInt(portInput.value, 10) || 8765, token: tokenInput.value });
});
```

`popup.css` — aggiungi stile minimo coerente con l'esistente:

```css
.config { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.config input { width: 100%; box-sizing: border-box; }
```

- [ ] **Step 4: Commit**

```bash
git add extension/
git commit -m "feat: configurable port and auth token via extension popup"
```

---

### Task 7: get_status ricco + versione centralizzata

**Files:**
- Modify: `server/protocol.js` (`export const VERSION = '1.1.0';`)
- Modify: `server/index.js` (usa `VERSION`)
- Modify: `server/tools.js` (get_status)

- [ ] **Step 1: VERSION in protocol.js** — `export const VERSION = '1.1.0';`. In `index.js`: `import { DEFAULT_PORT, VERSION } from './protocol.js';` e `version: VERSION` nel costruttore McpServer.

- [ ] **Step 2: get_status esteso** in tools.js (import `VERSION`):

```js
const startedAt = Date.now();

server.tool(
  'get_status',
  'Check bridge status: extension connection, server mode (primary/relay), port, version',
  {},
  async () => {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          connected: wsManager.isConnected(),
          mode: wsManager.mode,
          port: wsManager.port,
          version: VERSION,
          uptime_sec: Math.round((Date.now() - startedAt) / 1000),
        }, null, 2),
      }],
    };
  }
);
```

(`const startedAt` va all'inizio di `registerTools`.)

- [ ] **Step 3: Commit**

```bash
git add server/
git commit -m "feat: get_status reports mode, port, version, uptime"
```

---

### Task 8: Limiti output (max_length su read_page / execute_js)

**Files:** Modify: `server/tools.js`

- [ ] **Step 1: Helper truncate** in tools.js (sopra `registerTools`):

```js
function truncateText(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated, ${text.length - max} more chars — use max_length to raise the limit]`;
}
```

- [ ] **Step 2: read_page** — aggiungi param `max_length: z.number().optional().default(50000).describe('Max output chars (default 50000)')`; nel return: `text: truncateText(typeof data === 'string' ? data : JSON.stringify(data, null, 2), max_length)`.

- [ ] **Step 3: execute_js** — stesso param default 20000, applica `truncateText(JSON.stringify(data, null, 2), max_length)`.

- [ ] **Step 4: Commit**

```bash
git add server/tools.js
git commit -m "feat: max_length truncation on read_page and execute_js output"
```

---

### Task 9: Contrast check WCAG reale

**Files:** Modify: `extension/service-worker.js` (`cmdAccessibilityAudit`, blocco `// Contrast (basic)`)

- [ ] **Step 1: Sostituisci il blocco contrast** con calcolo del ratio WCAG (luminanza relativa, soglie 4.5:1 testo normale / 3:1 testo grande, background risolto risalendo i parent):

```js
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
```

- [ ] **Step 2: Commit**

```bash
git add extension/service-worker.js
git commit -m "feat: real WCAG contrast ratio check in accessibility_audit"
```

---

### Task 10: Cookie via chrome.cookies (HttpOnly inclusi)

**Files:**
- Modify: `extension/manifest.json` (+`cookies`)
- Modify: `extension/service-worker.js` (`cmdGetStorage`, `cmdSetStorage`)

- [ ] **Step 1: Manifest** — aggiungi `"cookies"` a permissions.

- [ ] **Step 2: cmdGetStorage** — ristruttura: ls/ss via script, cookies via API:

```js
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
```

- [ ] **Step 3: cmdSetStorage ramo cookie via API** — il ramo `sType === 'cookie'` esce dall'executeScript. Ristruttura `cmdSetStorage`:

```js
async function cmdSetStorage({ type, action, key, value, path, domain, expires, secure, sameSite, tab_id }) {
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
      if (expires) details.expirationDate = Math.floor(new Date(expires).getTime() / 1000);
      if (secure || sameSite === 'None') details.secure = true;
      if (sameSite) details.sameSite = sameSiteMap[sameSite];
      const c = await chrome.cookies.set(details);
      if (!c) throw new Error(chrome.runtime.lastError?.message || 'cookies.set failed');
      return { success: true, type: 'cookie', action: 'set', key };
    }
    if (action === 'delete') {
      if (!key) throw new Error('key is required for delete action');
      await chrome.cookies.remove({ url: tab.url, name: key });
      return { success: true, type: 'cookie', action: 'delete', key };
    }
    if (action === 'clear') {
      const cookies = await chrome.cookies.getAll({ url: tab.url });
      for (const c of cookies) await chrome.cookies.remove({ url: tab.url, name: c.name });
      return { success: true, type: 'cookie', action: 'clear', cleared: cookies.length };
    }
    throw new Error(`Invalid cookie action: ${action}`);
  }

  // localStorage / sessionStorage: invariato, via executeScript (rimuovi dal func il ramo cookie)
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
```

- [ ] **Step 4: Commit**

```bash
git add extension/
git commit -m "feat: cookies via chrome.cookies API (HttpOnly visible, reliable set/delete)"
```

---

### Task 11: Click robusto, watch_dom re-observe, screenshot doc

**Files:** Modify: `extension/service-worker.js`, `server/tools.js`

- [ ] **Step 1: Click con scrollIntoView + sequenza eventi** — sostituisci la func di `cmdClick`:

```js
func: (sel) => {
  const el = document.querySelector(sel);
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
```

- [ ] **Step 2: watch_dom — gestisci cambio selector** — in `cmdWatchDom`, esegui SEMPRE la injection func (rimuovi il gate `needsInjection`, mantieni `injectedTabs.dom` solo per cleanup su navigazione — anzi eliminalo del tutto per dom). Nella func di injection, in testa:

```js
if (window.__chromeBridge_domWatcherHooked && window.__chromeBridge_domWatchSelector !== sel) {
  if (window.__chromeBridge_domObserver) window.__chromeBridge_domObserver.disconnect();
  window.__chromeBridge_domWatcherHooked = false;
  window.__chromeBridge_domMutations = [];
}
if (window.__chromeBridge_domWatcherHooked) return;
window.__chromeBridge_domWatcherHooked = true;
window.__chromeBridge_domWatchSelector = sel;
// ...resto invariato
```

Rimuovi `injectedTabs.dom` da `injectedTabs` e dai listener `onUpdated`/`onRemoved` (la guard `__chromeBridge_domWatcherHooked` sparisce con la navigazione, quindi la re-injection è automatica).

- [ ] **Step 3: Documenta focus-stealing** — in `tools.js`, description di `screenshot`: `'Take a screenshot of a Chrome tab (returns base64 PNG image). Note: brings the tab to foreground and focuses its window.'` Stessa nota su `full_page_screenshot`.

- [ ] **Step 4: Commit**

```bash
git add extension/service-worker.js server/tools.js
git commit -m "feat: robust click event sequence; watch_dom selector change; document focus stealing"
```

---

### Task 12: Shadow DOM piercing (sintassi `>>>`)

**Files:** Modify: `extension/service-worker.js`, `server/tools.js` (descriptions)

- [ ] **Step 1: Helper inline** — `chrome.scripting.executeScript` serializza la func, quindi l'helper va duplicato inline in ogni func che lo usa. Helper canonico:

```js
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
```

Applica `deepQuery` (definita in testa alla func, poi `const el = deepQuery(sel)` al posto di `document.querySelector(sel)`) in: `cmdClick`, `cmdTypeText`, `cmdHover`, `cmdPressKey` (ramo selector), `cmdWaitForElement` (dentro `check()`). Applica `deepQueryAll` in `cmdQueryDom`.

- [ ] **Step 2: Aggiorna descriptions in tools.js** — per click, type_text, hover, press_key, wait_for_element, query_dom aggiungi alla description: `' Supports shadow DOM piercing with ">>>" (e.g. "my-app >>> button.save").'`

- [ ] **Step 3: Commit**

```bash
git add extension/service-worker.js server/tools.js
git commit -m "feat: shadow DOM piercing via '>>>' selector syntax"
```

---

### Task 13: Supporto iframe (get_frames + frame_id)

**Files:**
- Modify: `extension/manifest.json` (+`webNavigation`)
- Modify: `extension/service-worker.js`
- Modify: `server/protocol.js` (+`GET_FRAMES`)
- Modify: `server/tools.js`

- [ ] **Step 1: Manifest** — aggiungi `"webNavigation"` a permissions.

- [ ] **Step 2: Helper target + nuovo comando** in service-worker:

```js
function scriptTarget(tabId, frame_id) {
  const target = { tabId };
  if (frame_id !== undefined && frame_id !== null) target.frameIds = [frame_id];
  return target;
}

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
```

Case nel dispatcher: `case 'get_frames': return await cmdGetFrames(params);`

- [ ] **Step 3: frame_id nei comandi DOM** — nei seguenti cmd aggiungi `frame_id` alla destrutturazione dei param e sostituisci `target: { tabId }` con `target: scriptTarget(tabId, frame_id)`: `cmdExecuteJs` (entrambi i rami), `cmdClick`, `cmdTypeText`, `cmdReadPage` (tutti i rami), `cmdQueryDom`, `cmdModifyDom`, `cmdFillForm`, `cmdWaitForElement`, `cmdHover`, `cmdPressKey`, `cmdScrollTo`, `cmdGetPageInfo`.

- [ ] **Step 4: protocol.js** — aggiungi `GET_FRAMES: 'get_frames',` a MessageType.

- [ ] **Step 5: tools.js** — nuovo tool:

```js
server.tool(
  'get_frames',
  'List all frames (main + iframes) in a tab with their frameId, parent and URL. Use frameId with the frame_id parameter of DOM tools.',
  {
    tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
  },
  async ({ tab_id }) => {
    const data = await wsManager.sendCommand(MessageType.GET_FRAMES, { tab_id });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);
```

E aggiungi a execute_js, click, type_text, read_page, query_dom, modify_dom, fill_form, wait_for_element, hover, press_key, scroll_to, get_page_info il param:

```js
frame_id: z.number().optional().describe('Frame ID to target (from get_frames; default: main frame)'),
```

passandolo nel `sendCommand`.

- [ ] **Step 6: Commit**

```bash
git add extension/ server/
git commit -m "feat: iframe support — get_frames tool and frame_id param on DOM tools"
```

---

### Task 14: element_screenshot + full page stitched

**Files:**
- Modify: `extension/service-worker.js`
- Modify: `server/protocol.js` (+`ELEMENT_SCREENSHOT`, timeout)
- Modify: `server/tools.js`

- [ ] **Step 1: Helper immagini nel service worker** (sopra i cmd screenshot):

```js
async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return await createImageBitmap(blob);
}

async function canvasToBase64(canvas) {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
```

- [ ] **Step 2: cmdElementScreenshot**

```js
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
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: window.devicePixelRatio };
    },
    args: [selector],
    world: 'MAIN',
  });
  const rect = res?.[0]?.result;
  if (!rect || rect.width === 0 || rect.height === 0) throw new Error('Element has no visible area');

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
```

Case: `case 'element_screenshot': return await cmdElementScreenshot(params);`

- [ ] **Step 3: cmdFullPageScreenshot con stitching** — riscrivi:

```js
async function cmdFullPageScreenshot({ max_scrolls = 20, delay = 500, stitch = true, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  const safeDelay = Math.max(delay, 500);

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

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (sy) => window.scrollTo(0, sy),
    args: [originalScrollY],
    world: 'MAIN',
  });

  if (!stitch) {
    return {
      captures: shots.map((s) => s.dataUrl.replace(/^data:image\/png;base64,/, '')),
      scrollHeight, viewportHeight, totalCaptures: shots.length,
    };
  }

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
```

- [ ] **Step 4: protocol.js** — `ELEMENT_SCREENSHOT: 'element_screenshot',`; in `getTimeout` aggiungi `ELEMENT_SCREENSHOT` al ramo screenshot 10s.

- [ ] **Step 5: tools.js** — nuovo tool + aggiorna full_page_screenshot:

```js
server.tool(
  'element_screenshot',
  'Screenshot of a single element (scrolled into view, cropped via OffscreenCanvas). Returns base64 PNG. Brings tab to foreground.',
  {
    selector: z.string().describe('CSS selector of the element'),
    tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
  },
  async ({ selector, tab_id }) => {
    const data = await wsManager.sendCommand(MessageType.ELEMENT_SCREENSHOT, { selector, tab_id });
    if (data && data.image) {
      return { content: [{ type: 'image', data: data.image, mimeType: 'image/png' }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);
```

full_page_screenshot: aggiungi param `stitch: z.boolean().optional().default(true).describe('Stitch captures into one PNG (default true). false returns one image per viewport.')` e gestisci risposta:

```js
async ({ max_scrolls, delay, stitch, tab_id }) => {
  const data = await wsManager.sendCommand(MessageType.FULL_PAGE_SCREENSHOT, { max_scrolls, delay, stitch, tab_id });
  if (data.image) {
    const note = `Full page: ${data.totalCaptures} captures stitched, scrollHeight=${data.scrollHeight}${data.truncated ? ' (truncated at 16384px canvas limit)' : ''}`;
    return { content: [{ type: 'text', text: note }, { type: 'image', data: data.image, mimeType: 'image/png' }] };
  }
  const content = [{ type: 'text', text: `Full page screenshot: ${data.captures?.length || 0} captures, scrollHeight=${data.scrollHeight}, viewportHeight=${data.viewportHeight}` }];
  for (const img of data.captures || []) content.push({ type: 'image', data: img, mimeType: 'image/png' });
  return { content };
}
```

- [ ] **Step 6: Commit**

```bash
git add extension/service-worker.js server/
git commit -m "feat: element_screenshot and stitched full_page_screenshot via OffscreenCanvas"
```

---

### Task 15: tab_action (close/activate/reload/back/forward)

**Files:**
- Modify: `extension/service-worker.js`
- Modify: `server/protocol.js` (+`TAB_ACTION`)
- Modify: `server/tools.js`

- [ ] **Step 1: Helper waitForComplete** — estrai da `cmdNavigate` (e riusalo lì):

```js
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
```

`cmdNavigate` diventa: crea `const done = waitForComplete(tabId);` prima di `tabs.update`, poi `await done;`.

- [ ] **Step 2: cmdTabAction**

```js
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
```

Case: `case 'tab_action': return await cmdTabAction(params);`

- [ ] **Step 3: protocol + tool**

protocol.js: `TAB_ACTION: 'tab_action',`

tools.js:

```js
server.tool(
  'tab_action',
  'Tab lifecycle actions: close, activate (focus), reload (optional cache bypass), back, forward',
  {
    action: z.enum(['close', 'activate', 'reload', 'back', 'forward']).describe('Action to perform'),
    bypass_cache: z.boolean().optional().default(false).describe('For reload: bypass HTTP cache'),
    tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
  },
  async ({ action, bypass_cache, tab_id }) => {
    const data = await wsManager.sendCommand(MessageType.TAB_ACTION, { action, bypass_cache, tab_id });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);
```

- [ ] **Step 4: Commit**

```bash
git add extension/service-worker.js server/
git commit -m "feat: tab_action tool (close/activate/reload/back/forward)"
```

---

### Task 16: Console capture da document_start + errori window

**Files:**
- Create: `extension/console-capture.js`
- Modify: `extension/manifest.json` (content_scripts MAIN world)
- Modify: `extension/service-worker.js` (semplifica `cmdReadConsole`)

- [ ] **Step 1: `extension/console-capture.js`**

```js
/**
 * Iniettato a document_start in MAIN world: cattura console.* fin dal
 * primo istante di vita della pagina, più errori non gestiti.
 */
(() => {
  if (window.__chromeBridge_consoleHooked) return;
  window.__chromeBridge_consoleHooked = true;
  window.__chromeBridge_consoleLogs = [];
  const MAX = 1000;
  const push = (entry) => {
    if (window.__chromeBridge_consoleLogs.length < MAX) window.__chromeBridge_consoleLogs.push(entry);
  };
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
    const orig = console[method].bind(console);
    console[method] = (...args) => {
      push({
        level: method,
        args: args.map((a) => {
          try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
          catch { return String(a); }
        }),
        timestamp: Date.now(),
      });
      orig(...args);
    };
  }
  window.addEventListener('error', (e) => {
    push({ level: 'error', args: [`Uncaught ${e.message} at ${e.filename || '?'}:${e.lineno || 0}`], timestamp: Date.now() });
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    let reason;
    try { reason = String(e.reason); } catch { reason = '<unstringifiable>'; }
    push({ level: 'error', args: [`Unhandled rejection: ${reason}`], timestamp: Date.now() });
  });
})();
```

- [ ] **Step 2: Manifest content_scripts**

```json
"content_scripts": [
  {
    "matches": ["<all_urls>"],
    "js": ["console-capture.js"],
    "run_at": "document_start",
    "world": "MAIN"
  }
],
```

- [ ] **Step 3: Semplifica cmdReadConsole** — rimuovi il blocco di injection (`needsInjection` + executeScript di hook) e `injectedTabs.console` (anche dai listener di cleanup). Resta solo la lettura:

```js
async function cmdReadConsole({ clear = false, level = 'all', tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (shouldClear, filterLevel) => {
      const logs = window.__chromeBridge_consoleLogs || [];
      const filtered = filterLevel === 'all' ? logs : logs.filter((l) => l.level === filterLevel);
      if (shouldClear) window.__chromeBridge_consoleLogs = [];
      return filtered;
    },
    args: [clear, level],
    world: 'MAIN',
  });
  const messages = results?.[0]?.result ?? [];
  return { count: messages.length, messages };
}
```

Aggiorna description in tools.js: `'Read console messages captured from page load (hook installed at document_start), including uncaught errors and unhandled rejections.'`

- [ ] **Step 4: Commit**

```bash
git add extension/
git commit -m "feat: console capture from document_start incl. uncaught errors and rejections"
```

---

### Task 17: Nuovi tool — upload_file, wait_for_navigation, wait_for_network_idle, handle_dialogs, find_text, HAR + browser network

**Files:**
- Modify: `server/protocol.js`, `server/tools.js`, `extension/service-worker.js`, `extension/manifest.json` (+`webRequest`)
- Create: `test/unit/har.test.js`, `server/har.js`

- [ ] **Step 1: protocol.js — nuovi tipi**

```js
  UPLOAD_FILE:          'upload_file',
  WAIT_FOR_NAVIGATION:  'wait_for_navigation',
  WAIT_FOR_NETWORK_IDLE:'wait_for_network_idle',
  HANDLE_DIALOGS:       'handle_dialogs',
  FIND_TEXT:            'find_text',
```

In `getTimeout`: `WAIT_FOR_NAVIGATION` e `WAIT_FOR_NETWORK_IDLE` → 60000 (insieme a `WAIT_FOR_ELEMENT`). `UPLOAD_FILE` → 60000 (payload grossi).

- [ ] **Step 2: upload_file** — tools.js (import `readFile` da `node:fs/promises`, `basename`, `extname` da `node:path`):

```js
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.zip': 'application/zip', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

server.tool(
  'upload_file',
  'Set a file on an input[type=file] element. Reads the file from the server filesystem and injects it via DataTransfer (max 10MB).',
  {
    selector: z.string().describe('CSS selector of the file input'),
    path: z.string().describe('Absolute path of the file on the server machine'),
    mime_type: z.string().optional().describe('MIME type (default: inferred from extension)'),
    tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
  },
  async ({ selector, path, mime_type, tab_id }) => {
    const buf = await readFile(path);
    if (buf.length > 10 * 1024 * 1024) throw new Error(`File too large: ${buf.length} bytes (max 10MB)`);
    const mime = mime_type || MIME_BY_EXT[extname(path).toLowerCase()] || 'application/octet-stream';
    const data = await wsManager.sendCommand(MessageType.UPLOAD_FILE, {
      selector, name: basename(path), mime_type: mime, content_b64: buf.toString('base64'), tab_id,
    });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);
```

service-worker:

```js
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
```

- [ ] **Step 3: wait_for_navigation** — service-worker (usa `waitForComplete` del Task 15):

```js
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

  await waitForComplete(tabId, timeout - (Date.now() - start));
  const t = await chrome.tabs.get(tabId);
  return { navigated: true, url: t.url, title: t.title, elapsed: Date.now() - start };
}
```

tools.js:

```js
server.tool(
  'wait_for_navigation',
  'Wait for the tab to finish navigating (e.g. after a click that triggers a page load). Resolves when tab status is complete.',
  {
    timeout: z.number().optional().default(15000).describe('Max wait in ms'),
    tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
  },
  async ({ timeout, tab_id }) => {
    const data = await wsManager.sendCommand(MessageType.WAIT_FOR_NAVIGATION, { timeout, tab_id });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);
```

- [ ] **Step 4: wait_for_network_idle** — prima estrai l'injection del network hook in helper `ensureNetworkHook(tabId)` (sposta il blocco `if (needsInjection) {...}` di `cmdMonitorNetwork` in una funzione riusabile). Nel hook di rete aggiungi tracking in-flight: dopo `window.__chromeBridge_networkRequests = [];` aggiungi `window.__chromeBridge_inflight = 0; window.__chromeBridge_lastNetActivity = Date.now();` — nel patch fetch: `window.__chromeBridge_inflight++; window.__chromeBridge_lastNetActivity = Date.now();` all'inizio e `window.__chromeBridge_inflight--; window.__chromeBridge_lastNetActivity = Date.now();` sia nel ramo success sia nel catch. Nel patch XHR: incrementa in `send`, decrementa in un listener `loadend` (copre load, error e abort).

```js
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
```

tools.js:

```js
server.tool(
  'wait_for_network_idle',
  'Wait until no XHR/fetch requests are in flight for idle_ms. Useful after actions that trigger async loading.',
  {
    idle_ms: z.number().optional().default(500).describe('Quiet period in ms'),
    timeout: z.number().optional().default(15000).describe('Max wait in ms'),
    tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
  },
  async ({ idle_ms, timeout, tab_id }) => {
    const data = await wsManager.sendCommand(MessageType.WAIT_FOR_NETWORK_IDLE, { idle_ms, timeout, tab_id });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);
```

- [ ] **Step 5: handle_dialogs** — service-worker:

```js
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
```

tools.js:

```js
server.tool(
  'handle_dialogs',
  'Auto-handle JS dialogs (alert/confirm/prompt): accept or dismiss future dialogs, log intercepted ones. action=reset restores native dialogs and returns the log. Does not cover beforeunload or browser-native dialogs.',
  {
    action: z.enum(['accept', 'dismiss', 'reset']).optional().default('accept').describe('Policy for future dialogs, or reset'),
    prompt_text: z.string().optional().describe('Text returned by window.prompt when accepting'),
    tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
  },
  async ({ action, prompt_text, tab_id }) => {
    const data = await wsManager.sendCommand(MessageType.HANDLE_DIALOGS, { action, prompt_text, tab_id });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);
```

- [ ] **Step 6: find_text** — service-worker:

```js
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
            position: { x: Math.round(rect.x), y: Math.round(rect.y + window.scrollY) },
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
```

tools.js:

```js
server.tool(
  'find_text',
  'Find text occurrences on the page. Returns parent element selector, surrounding context, visibility and page position for each match.',
  {
    text: z.string().describe('Text to search for'),
    case_sensitive: z.boolean().optional().default(false).describe('Case-sensitive match'),
    max_results: z.number().optional().default(20).describe('Max matches to return'),
    tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
  },
  async ({ text, case_sensitive, max_results, tab_id }) => {
    const data = await wsManager.sendCommand(MessageType.FIND_TEXT, { text, case_sensitive, max_results, tab_id });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);
```

- [ ] **Step 7: HAR export (TDD) + browser-level network**

Test `test/unit/har.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHar } from '../../server/har.js';

test('converte richieste in HAR 1.2', () => {
  const har = toHar([
    { type: 'fetch', method: 'GET', url: 'https://x.test/a', startTime: 1700000000000, status: 200, duration: 123 },
    { type: 'xhr', method: 'POST', url: 'https://x.test/b', startTime: 1700000001000, status: null, duration: null, error: 'Network error' },
  ]);
  assert.equal(har.log.version, '1.2');
  assert.equal(har.log.entries.length, 2);
  assert.equal(har.log.entries[0].request.method, 'GET');
  assert.equal(har.log.entries[0].response.status, 200);
  assert.equal(har.log.entries[0].time, 123);
  assert.equal(har.log.entries[1].response.status, 0);
});
```

Run: FAIL → implementa `server/har.js`:

```js
import { VERSION } from './protocol.js';

export function toHar(requests) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'chrome-bridge', version: VERSION },
      entries: requests.map((r) => ({
        startedDateTime: new Date(r.startTime).toISOString(),
        time: r.duration ?? 0,
        request: { method: r.method || 'GET', url: r.url, httpVersion: '', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: -1 },
        response: { status: r.status ?? 0, statusText: r.error || '', httpVersion: '', headers: [], cookies: [], content: { size: -1, mimeType: '' }, redirectURL: '', headersSize: -1, bodySize: -1 },
        cache: {},
        timings: { send: 0, wait: r.duration ?? 0, receive: 0 },
      })),
    },
  };
}
```

Run: PASS.

Browser-level capture — manifest: aggiungi `"webRequest"` a permissions. service-worker, fuori dai cmd:

```js
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
```

In `chrome.tabs.onRemoved` aggiungi `browserNetLog.delete(tabId);`.

`cmdMonitorNetwork` — param `source = 'page'`:

```js
async function cmdMonitorNetwork({ clear = false, source = 'page', tab_id }) {
  const tabId = await resolveTabId(tab_id);
  if (source === 'browser') {
    const requests = browserNetLog.get(tabId) ?? [];
    if (clear) browserNetLog.set(tabId, []);
    return { count: requests.length, requests: [...requests] };
  }
  await ensureNetworkHook(tabId);
  // ...lettura invariata
}
```

tools.js monitor_network — nuovi param e conversione HAR (import `toHar` da `./har.js`):

```js
{
  clear: z.boolean().optional().default(false).describe('Clear captured requests after reading'),
  source: z.enum(['page', 'browser']).optional().default('page').describe('page = fetch/XHR hook; browser = all requests incl. static assets via webRequest'),
  format: z.enum(['json', 'har']).optional().default('json').describe('Output format'),
  tab_id: z.number().optional().describe('Tab ID (default: active tab)'),
},
async ({ clear, source, format, tab_id }) => {
  const data = await wsManager.sendCommand(MessageType.MONITOR_NETWORK, { clear, source, tab_id });
  const out = format === 'har' ? toHar(data.requests ?? []) : data;
  return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
}
```

- [ ] **Step 8: Dispatcher cases** — aggiungi al dispatcher: `upload_file`, `wait_for_navigation`, `wait_for_network_idle`, `handle_dialogs`, `find_text`.

- [ ] **Step 9: Test e commit**

Run: `npm run test:unit` → Expected: PASS

```bash
git add server/ extension/ test/unit/har.test.js
git commit -m "feat: upload_file, wait_for_navigation, wait_for_network_idle, handle_dialogs, find_text, HAR export, browser-level network capture"
```

---

### Task 18: Versioni, README, verifica e2e

**Files:**
- Modify: `package.json` (version 1.1.0), `extension/manifest.json` (version 1.1.0)
- Modify: `README.md`
- Modify: `test/test-devtools.js` (se servono adattamenti per i nuovi handshake/comandi)

- [ ] **Step 1: Bump versioni** — `package.json` e `manifest.json` → `1.1.0` (protocol.js VERSION già 1.1.0 dal Task 7).

- [ ] **Step 2: README** — aggiorna: conteggio tool 31 → 39 (titoli e tabella comparativa); nuova sezione tool: `get_frames`, `element_screenshot`, `tab_action`, `upload_file`, `wait_for_navigation`, `wait_for_network_idle`, `handle_dialogs`, `find_text`; nuove env var (`CHROME_BRIDGE_TOKEN`); sezione Security (handshake ext_init, origin check, relay loopback-only, token opzionale); porta configurabile da popup; check_links ora server-side; full_page_screenshot stitched; console capture da document_start; shadow DOM `>>>`; frame_id; cookie HttpOnly; sezione test (`npm run test:unit` + e2e). Aggiorna la riga della tabella comparativa "Dialog handling" → Yes (JS dialogs).

- [ ] **Step 3: Unit test completi**

Run: `npm run test:unit`
Expected: PASS, 0 failure

- [ ] **Step 4: Verifica e2e manuale (richiede utente)**

Procedura:
1. Ricaricare l'estensione in `chrome://extensions` (Reload) — nuovi permessi richiedono conferma.
2. Riavviare il server MCP (o sessione Claude Code).
3. `get_status` → atteso `{connected: true, mode: 'primary', version: '1.1.0'}`.
4. Smoke test sui tool nuovi contro una pagina di test (example.com + una pagina con form): navigate, screenshot, element_screenshot, full_page_screenshot (stitched), find_text, tab_action reload/back, check_links, read_console (errore generato ad hoc con execute_js `throw`), handle_dialogs + execute_js `confirm('x')`.
5. Eseguire `node test/test-devtools.js` (col server MCP fermo) — atteso: tutti i casi PASS.

- [ ] **Step 5: Commit finale**

```bash
git add README.md package.json extension/manifest.json test/
git commit -m "chore: bump to 1.1.0, document new tools and security model"
```

---

## Note di self-review

- **Ordine**: ogni task lascia il sistema funzionante. I task 1–4 toccano il trasporto (test unit subito); 5–11 fix/migliorie indipendenti; 12–17 feature; 18 chiude.
- **Dipendenze fra task**: Task 15 definisce `waitForComplete` usato dal Task 17 (wait_for_navigation) — ordine rispettato. Task 17 usa `ensureNetworkHook` estratto nello stesso task. Task 7 definisce `VERSION` usato da `server/har.js` (Task 17) — ordine rispettato.
- **Compatibilità**: dopo il Task 1 l'estensione vecchia non si connette più (manca ext_init) — l'estensione va ricaricata insieme al riavvio del server. Non c'è installazione esterna da preservare (npm package, ma major-bump accettato in 1.1.0 perché server+extension si aggiornano insieme).
- **Estensione non testabile in CI**: i func iniettati sono verificati solo dall'e2e del Task 18 — eseguirlo davvero prima di dichiarare il lavoro finito.

---

# ESTENSIONE PIANO (approvata 2026-06-12): 17 tool aggiuntivi → v1.2.0

Task 18 finale slitta dopo questi. Conteggio tool finale: 56.

### Task 19: network_rules (declarativeNetRequest)
Manifest +`declarativeNetRequest`. Tool `network_rules` {action: block|redirect|modify_header|list|clear, url_filter, redirect_url, header, header_value, resource_types?}. SW: updateDynamicRules, id = max+1, list via getDynamicRules. Nota: regole browser-global, non per-tab.

### Task 20: screenshot_diff
Tool {action: baseline|compare, name, selector?, tab_id}. Baseline: cattura (viewport o elemento) → Map in-memory SW. Compare: ricattura, getImageData diff pixel (soglia canale 10), % cambiati + immagine diff (pixel cambiati rossi su base sbiadita). Persa su suspend SW — documentare.

### Task 21: monitor_websocket + web_vitals + list_event_listeners
Nuovo content script `extension/page-instrumentation.js` (document_start MAIN, accodato in manifest): PerformanceObserver layout-shift/longtask/event(INP approx)/LCP → __chromeBridge_vitals; patch EventTarget.addEventListener → __chromeBridge_listeners (cap 2000). Patch WebSocket lazy via ensureWsHook (come network): __chromeBridge_wsLog cap 500, direzione in/out, preview 500 char. Tool monitor_websocket {clear}, web_vitals {}, list_event_listeners {type?, limit}.

### Task 22: seo_audit + extract_table + unused_css
seo_audit: title/meta desc lunghezze, canonical, robots, og/twitter, h1 count, JSON-LD parse+errori, hreflang, lang, viewport, favicon → shape come accessibility_audit. extract_table {selector?, index?, max_rows} → JSON (th→chiavi, fallback array). unused_css: itera styleSheets same-origin (cross-origin → inaccessible), selettori senza match (pseudo strip), summary+lista cap.

### Task 23: drag_and_drop + clipboard + set_geolocation + type_text mode keys
Manifest +clipboardRead/clipboardWrite. drag_and_drop {source_selector, target_selector, mode: html5|pointer}. clipboard {action: read|write, text} (navigator.clipboard + fallback execCommand). set_geolocation {latitude, longitude, accuracy?, reset} patch navigator.geolocation MAIN. type_text param mode 'set'(default)|'keys' (per-char keydown/input/keyup, delay 10ms, func async).

### Task 24: manage_downloads + save_page + set_zoom + http_auth
Manifest +downloads, pageCapture, webRequestAuthProvider. manage_downloads {action: list|wait_for_complete, timeout}. save_page {output_path} → pageCapture.saveAsMHTML → base64 → Node scrive file, ritorna path+size. set_zoom {factor?|reset} via tabs.setZoom. http_auth {action: set|clear, username, password} → onAuthRequired asyncBlocking, guard requestId anti-loop.

### Task 25: security_headers + session_fixture
webRequest onHeadersReceived ['responseHeaders'] main_frame → Map per tab. Tool security_headers: extension ritorna header raw; valutazione server-side in server/security-headers.js (CSP, HSTS, XFO, XCTO, Referrer-Policy, Permissions-Policy, Server leak) CON unit test (TDD). session_fixture {action: save|restore, name}: orchestrazione GET_STORAGE/SET_STORAGE in tools.js, file JSON in ~/.config/chrome-bridge/sessions/.

### Task 18 (finale, aggiornato): bump 1.2.0, README 56 tool, e2e

---

# ESTENSIONE 2 (2026-06-12): anti-blocco navigazione → v1.3.0

Attacca le casistiche di interruzione più frequenti. 4 nuovi tool (56→60) + hardening + param. Task 18b finale ribumpa a 1.3.0.

### Task 26: get_interactives + wait_for_function + scroll_until
- get_interactives {scope?, limit, visible_only, tab_id, frame_id}: lista elementi azionabili (button, a[href], input, select, textarea, [role=button], [onclick], [tabindex], summary) con selettore stabile (id → data-testid → nth-of-type path), testo/label, tag, type, rect, enabled, visible, occluded (elementFromPoint center ≠ self). Cap default 100. Selettore generato deterministico e ri-usabile dagli altri tool.
- wait_for_function {expression, timeout, polling_ms, tab_id, frame_id}: polla `!!eval(expression)` in MAIN finché true o timeout; ritorna {satisfied, elapsed, value}. Generalizza wait_for_element.
- scroll_until {until: 'element'|'network_idle'|'no_new_content', selector?, max_scrolls, step_px?, settle_ms, tab_id}: scroll ripetuto finché condizione. element → wait selector visibile; network_idle → riusa inflight da ensureNetworkHook; no_new_content → scrollHeight stabile per 2 step. Ritorna {stopped_reason, scrolls, finalScrollY}.

### Task 27: wait_after param + click hardening
- click hardening: dopo scrollIntoView, prima della sequenza eventi, `document.elementFromPoint(cx,cy)`; se non è il target né suo discendente/antenato → ritorna {clicked:false, occluded:true, occluder:{selector,tag,text}} senza fingere successo. Param `force` (default false) bypassa il check.
- wait_after su click, type_text, fill_form: enum 'none'(default)|'navigation'|'networkidle'. Dopo l'azione, lato server (tools.js) se wait_after≠none chiama il rispettivo WAIT_FOR_NAVIGATION/WAIT_FOR_NETWORK_IDLE sul medesimo tab e include il risultato nella risposta. NON nell'estensione — orchestrazione in tools.js per riuso.

### Task 28: SPA route tracking + dismiss_overlays
- page-instrumentation.js: patch history.pushState/replaceState + listener popstate → __chromeBridge_routes [{url, type, timestamp}] cap 200, e __chromeBridge_lastRoute. Nuova modalità wait_for_navigation param `mode: 'load'(default)|'spa'`: spa → wait_for_function-style poll su lastRoute change da baseline catturata a inizio chiamata.
- dismiss_overlays {strategy: 'auto'(default), tab_id}: euristica consent/modali. Selettori noti (OneTrust #onetrust-accept-btn-handler, Cookiebot #CybotCookiebotDialogBodyButtonAccept, Usercentrics, generico [aria-label*=accept i], button con testo /^(accetta|accetto|accept all|agree|ok|got it|consenti)/i dentro elementi position fixed/sticky o z-index alto). Clicca il primo match visibile, ritorna {dismissed:[{selector,text}], count}. Idempotente.

### Task 18b (finale): bump 1.3.0, README 60 tool, push
