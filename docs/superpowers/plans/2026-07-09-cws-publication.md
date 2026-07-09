# Chrome Web Store Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere l'estensione "Chrome Bridge for Claude Code" pubblicabile sul Chrome Web Store: eliminare `eval()` migrando a `chrome.userScripts.execute()`, produrre privacy policy, testi listing, asset grafici, zip e checklist di submission.

**Architecture:** L'estensione MV3 (`extension/`) esegue comandi ricevuti via WebSocket `localhost:8765` dal server MCP (`server/`). Oggi 3 punti usano `eval()` su codice arbitrario (vietato dalle policy CWS); migrano all'API `chrome.userScripts.execute()` (Chrome 135+), che richiede all'utente il toggle "Allow user scripts". Tutto il resto è documentazione/asset per la submission.

**Tech Stack:** Chrome Extension MV3, `chrome.userScripts` API, Node.js 18+ (server MCP), GitHub Pages, bash.

**Spec:** `docs/superpowers/specs/2026-07-09-cws-publication-design.md`

## Global Constraints

- `minimum_chrome_version`: `"135"` (richiesto da `chrome.userScripts.execute()`).
- Versione target: `1.5.0` sincronizzata in `extension/manifest.json` e `package.json`.
- Zero occorrenze di `eval(` e `new Function` in `extension/` a fine lavori.
- Tutti i testi destinati allo store e la privacy policy in **inglese**; commenti codice in italiano (convenzione repo esistente).
- Messaggio di errore toggle, identico ovunque: `User scripts are disabled. Open chrome://extensions, click Details on Chrome Bridge, and enable 'Allow user scripts' (on Chrome 135-137 enable Developer Mode instead). Then retry.`
- Repo pubblico: `https://github.com/frsorrentino/chrome-bridge`. URL privacy finale: `https://frsorrentino.github.io/chrome-bridge/privacy`.
- Test integration (`node test/test-devtools.js`) richiedono: estensione ricaricata in chrome://extensions, toggle "Allow user scripts" attivo, **nessun** server MCP primario in esecuzione sulla porta 8765 (lo script avvia il proprio WSManager; fermare eventuali processi: `pgrep -af chrome-bridge/server/index.js`). Se esegui come agente e serve ricaricare l'estensione o attivare il toggle: chiedi all'utente, non è automatizzabile.

---

### Task 1: Manifest 1.5.0 + permesso userScripts + riferimenti versione

**Files:**
- Modify: `extension/manifest.json`
- Modify: `package.json` (campo `version`)
- Modify: `README.md` (3 punti: riga 3, riga 150, riga 248 — "Chrome 111+" → "Chrome 135+")

**Interfaces:**
- Produces: manifest con permesso `"userScripts"` (necessario ai Task 2-3), `minimum_chrome_version: "135"`, `version: "1.5.0"`, `homepage_url`, `description` inglese ≤132 char.

- [ ] **Step 1: Aggiorna manifest.json**

Sostituisci in `extension/manifest.json`:

```json
  "version": "1.5.0",
  "description": "Bridge your browser to Claude Code: 56 web-dev automation tools over a local WebSocket. Self-hosted, works on ChromeOS.",
  "homepage_url": "https://github.com/frsorrentino/chrome-bridge",
  "minimum_chrome_version": "135",
```

e nell'array `permissions` aggiungi `"userScripts"` dopo `"scripting"`:

```json
  "permissions": [
    "tabs",
    "scripting",
    "userScripts",
    "alarms",
    "storage",
    "cookies",
    "webNavigation",
    "webRequest",
    "declarativeNetRequest",
    "clipboardRead",
    "clipboardWrite",
    "downloads",
    "pageCapture",
    "webRequestAuthProvider"
  ],
```

- [ ] **Step 2: Bump package.json**

In `package.json`: `"version": "1.5.0"`. La `description` del package resta invariata.

- [ ] **Step 3: Aggiorna README**

Tre sostituzioni testuali:
- riga 3: `works on any platform with Chrome 111+` → `works on any platform with Chrome 135+`
- riga 150: `Requires **Node.js 18+** and **Chrome 111+**` → `Requires **Node.js 18+** and **Chrome 135+**`
- riga 248: `# Chrome MV3 manifest (min Chrome 111)` → `# Chrome MV3 manifest (min Chrome 135)`

- [ ] **Step 4: Verifica JSON validi**

Run: `node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json')); JSON.parse(require('fs').readFileSync('package.json')); console.log('OK')"`
Expected: `OK`

Verifica lunghezza description ≤132:
Run: `node -e "const m=JSON.parse(require('fs').readFileSync('extension/manifest.json')); console.log(m.description.length)"`
Expected: numero ≤ 132

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json package.json README.md
git commit -m "feat: manifest 1.5.0 — userScripts permission, min Chrome 135"
```

---

### Task 2: Helper userScripts + refactor cmdExecuteJs (via eval n.1 e n.2)

**Files:**
- Modify: `extension/service-worker.js:345-351` (dopo `scriptTarget`, aggiungi helper) e `:448-499` (riscrivi `cmdExecuteJs`)

**Interfaces:**
- Consumes: permesso `"userScripts"` dal Task 1; helper esistenti `resolveTabId(tab_id)` e `scriptTarget(tabId, frame_id)` (già in service-worker.js:337-351, invariati).
- Produces: `USER_SCRIPTS_HELP` (const string), `userScriptsAvailable(): boolean`, `assertUserScripts(): void|throw`, `runUserScript(target, code, world): Promise<any>` — usati anche dal Task 3. `cmdExecuteJs` mantiene il contratto esistente: input `{ code, tab_id, frame_id }`, output `{ result: any|null }`, throw su errore.

- [ ] **Step 1: Aggiungi helper userScripts**

In `extension/service-worker.js`, subito dopo la funzione `scriptTarget` (riga ~351), inserisci:

```js
// --- Utility: chrome.userScripts (esecuzione codice utente, CWS-compliant) ---

const USER_SCRIPTS_HELP = "User scripts are disabled. Open chrome://extensions, click Details on Chrome Bridge, and enable 'Allow user scripts' (on Chrome 135-137 enable Developer Mode instead). Then retry.";

function userScriptsAvailable() {
  // L'accesso alla proprietà lancia se l'utente non ha attivato il toggle
  try {
    chrome.userScripts.getScripts;
    return true;
  } catch {
    return false;
  }
}

function assertUserScripts() {
  if (!userScriptsAvailable()) throw new Error(USER_SCRIPTS_HELP);
}

async function runUserScript(target, code, world) {
  const results = await chrome.userScripts.execute({
    target,
    js: [{ code }],
    world,
  });
  const r = results?.[0];
  if (r && r.error !== undefined && r.error !== null) throw new Error(String(r.error));
  return r?.result;
}
```

- [ ] **Step 2: Riscrivi cmdExecuteJs**

Sostituisci l'intera funzione `cmdExecuteJs` (service-worker.js:448-499, i due blocchi `chrome.scripting.executeScript` con `eval`) con:

```js
async function cmdExecuteJs({ code, tab_id, frame_id }) {
  if (!code) throw new Error('Missing required parameter: code');
  assertUserScripts();
  const tabId = await resolveTabId(tab_id);
  const target = scriptTarget(tabId, frame_id);

  // Strategia: USER_SCRIPT world (isolato, non soggetto alla CSP della pagina).
  // Fallback: MAIN world per codice che legge variabili della pagina.
  try {
    const val = await runUserScript(target, code, 'USER_SCRIPT');
    return { result: val ?? null };
  } catch (userWorldErr) {
    try {
      const val = await runUserScript(target, code, 'MAIN');
      return { result: val ?? null };
    } catch (mainErr) {
      throw new Error(`${mainErr.message} (USER_SCRIPT world: ${userWorldErr.message})`);
    }
  }
}
```

Nota parità semantica: come con `eval`, il valore restituito è il completion value dell'ultimo statement; errori del codice utente in USER_SCRIPT world fanno scattare il retry in MAIN (utile quando il codice riferisce variabili di pagina).

- [ ] **Step 3: Verifica zero eval residui in cmdExecuteJs**

Run: `grep -n "eval(" extension/service-worker.js`
Expected: una sola occorrenza residua, riga ~3348 (`cmdWaitForFunction`, la sistema il Task 3).

- [ ] **Step 4: Test manuale end-to-end**

Prerequisito (chiedi all'utente se agente): ricarica estensione in chrome://extensions e attiva "Allow user scripts" nei dettagli.

Run: `node server/cli.js js "1 + 1"`
Expected: output JSON con `"result":2`

Run: `node server/cli.js js "document.title"`
Expected: titolo della tab attiva.

Test degradazione (chiedi all'utente di spegnere il toggle, poi):
Run: `node server/cli.js js "1 + 1"`
Expected: errore contenente `User scripts are disabled. Open chrome://extensions`. Poi far riattivare il toggle.

- [ ] **Step 5: Commit**

```bash
git add extension/service-worker.js
git commit -m "feat: execute_js via chrome.userScripts.execute — no eval, CWS-compliant"
```

---

### Task 3: Refactor cmdWaitForFunction (via eval n.3) + test integration

**Files:**
- Modify: `extension/service-worker.js:3338-3367` (riscrivi `cmdWaitForFunction`)
- Modify: `test/test-devtools.js` (aggiungi caso WAIT_FOR_FUNCTION)

**Interfaces:**
- Consumes: `assertUserScripts()`, `runUserScript(target, code, world)` dal Task 2; `resolveTabId`, `scriptTarget` esistenti.
- Produces: `cmdWaitForFunction` con contratto invariato: input `{ expression, timeout=10000, polling_ms=100, tab_id, frame_id }`, output `{ satisfied: boolean, elapsed: number, value?|lastValue? }`.

- [ ] **Step 1: Riscrivi cmdWaitForFunction**

Sostituisci l'intera funzione (service-worker.js:3338-3367). Il loop di polling passa dal codice iniettato al service worker: una micro-iniezione per tentativo (robusto anche attraverso navigazioni; overhead irrilevante a polling ≥50ms).

```js
async function cmdWaitForFunction({ expression, timeout = 10000, polling_ms = 100, tab_id, frame_id }) {
  if (!expression) throw new Error('Missing required parameter: expression');
  assertUserScripts();
  const tabId = await resolveTabId(tab_id);
  const target = scriptTarget(tabId, frame_id);
  const intv = Math.max(polling_ms, 50);
  // L'espressione utente è interpolata nel codice user-script (niente eval)
  const probe = `(() => {
    try {
      const __v = (${expression});
      let s = __v;
      try { s = (typeof __v === 'object' && __v !== null) ? JSON.parse(JSON.stringify(__v)) : __v; } catch { s = String(__v); }
      return { truthy: !!__v, value: s ?? null };
    } catch (e) {
      return { truthy: false, value: { __error: e.message } };
    }
  })()`;
  const start = Date.now();
  let last = null;
  for (;;) {
    let r = null;
    try {
      r = await runUserScript(target, probe, 'MAIN');
    } catch (e) {
      r = { truthy: false, value: { __error: e.message } };
    }
    if (r && r.truthy) {
      return { satisfied: true, elapsed: Date.now() - start, value: r.value };
    }
    last = r ? r.value : null;
    if (Date.now() - start >= timeout) {
      return { satisfied: false, elapsed: Date.now() - start, lastValue: last };
    }
    await new Promise((res) => setTimeout(res, intv));
  }
}
```

- [ ] **Step 2: Verifica zero eval nell'estensione**

Run: `grep -rn "eval(\|new Function" extension/`
Expected: nessun output.

- [ ] **Step 3: Aggiungi test integration wait_for_function**

In `test/test-devtools.js`, dopo il blocco dei test `wait_for_element` (righe ~218-240), aggiungi una funzione test e registrala accanto alle chiamate esistenti (stesso pattern `ok(name)` / `fail(name, err)` del file):

```js
async function testWaitForFunction() {
  {
    const name = 'wait_for_function (satisfied)';
    try {
      const r = await wsManager.sendCommand(MessageType.WAIT_FOR_FUNCTION, {
        expression: 'document.readyState === "complete" || document.readyState === "interactive"',
        timeout: 5000,
      });
      if (r.satisfied === true) ok(name);
      else fail(name, `satisfied=${r.satisfied}`);
    } catch (e) { fail(name, e.message); }
  }
  {
    const name = 'wait_for_function (timeout)';
    try {
      const r = await wsManager.sendCommand(MessageType.WAIT_FOR_FUNCTION, {
        expression: 'window.__never_exists_xyz === 42',
        timeout: 1200,
        polling_ms: 100,
      });
      if (r.satisfied === false && r.elapsed >= 1200) ok(name);
      else fail(name, `satisfied=${r.satisfied} elapsed=${r.elapsed}`);
    } catch (e) { fail(name, e.message); }
  }
}
```

Individua nel file il punto in cui vengono invocate in sequenza le altre funzioni di test (funzione main/runner) e aggiungi `await testWaitForFunction();` accanto alle altre.

- [ ] **Step 4: Esegui suite integration**

Prerequisiti: estensione ricaricata, toggle attivo, nessun MCP server primario su 8765 (verifica: `pgrep -af chrome-bridge/server/index.js` — se gira dentro una sessione Claude Code attiva, chiedi all'utente come procedere).

Run: `node test/test-devtools.js`
Expected: tutti i test PASS, inclusi i 2 nuovi `wait_for_function` e i test esistenti che usano `EXECUTE_JS` (righe 166, 196, 274, 293 — coprono il refactor del Task 2).

- [ ] **Step 5: Esegui unit test**

Run: `npm run test:unit`
Expected: tutti PASS (nessun unit test tocca i comandi extension-side, è una regressione guard).

- [ ] **Step 6: Commit**

```bash
git add extension/service-worker.js test/test-devtools.js
git commit -m "feat: wait_for_function via userScripts polling — ultimo eval rimosso"
```

---

### Task 4: Warning toggle nel popup

**Files:**
- Modify: `extension/popup.html:13` (dopo il div `.status`)
- Modify: `extension/popup.js` (in coda)
- Modify: `extension/popup.css` (in coda)

**Interfaces:**
- Consumes: permesso `userScripts` (Task 1); stesso check try/catch di `userScriptsAvailable()` (il popup gira nello stesso contesto estensione, l'API check funziona identico).

- [ ] **Step 1: Aggiungi elemento warning in popup.html**

Dopo il `</div>` della `.status` (riga 13) e prima del `<p class="info">`:

```html
    <div id="us-warning" class="warning" hidden>
      ⚠ execute_js and wait_for(function) need "Allow user scripts":<br>
      chrome://extensions → Chrome Bridge → Details → Allow user scripts
    </div>
```

- [ ] **Step 2: Logica in popup.js**

In coda a `extension/popup.js`:

```js
// Warning se il toggle "Allow user scripts" è spento
const usWarning = document.getElementById('us-warning');
try {
  chrome.userScripts.getScripts;
} catch {
  if (usWarning) usWarning.hidden = false;
}
```

- [ ] **Step 3: Stile in popup.css**

In coda a `extension/popup.css`:

```css
.warning {
  margin-top: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  background: #fff3cd;
  color: #664d03;
  font-size: 11px;
  line-height: 1.4;
}
```

- [ ] **Step 4: Verifica manuale**

Chiedi all'utente (o verifica se hai accesso al browser): estensione ricaricata, popup aperto.
- Toggle attivo → warning assente.
- Toggle spento → warning visibile.

- [ ] **Step 5: Commit**

```bash
git add extension/popup.html extension/popup.js extension/popup.css
git commit -m "feat: popup warning quando Allow user scripts è disattivo"
```

---

### Task 5: Descrizioni tool lato server

**Files:**
- Modify: `server/tools.js:155` (description `execute_js`) e `:452` (describe di `expression` in `wait_for`)

**Interfaces:**
- Consumes: nulla. Produces: nulla per altri task (solo testo per l'LLM client).

- [ ] **Step 1: Aggiorna description execute_js**

`server/tools.js:155`, sostituisci:

```js
    'Execute JavaScript code in a Chrome tab page context',
```

con:

```js
    'Execute JavaScript code in a Chrome tab page context. Requires the "Allow user scripts" toggle on the extension (chrome://extensions > Chrome Bridge > Details); the error message explains how if disabled.',
```

- [ ] **Step 2: Aggiorna describe di expression in wait_for**

`server/tools.js:452`, sostituisci:

```js
      expression: z.string().optional().describe('JS expression evaluated in page context, e.g. "window.app && app.ready" (condition=function)'),
```

con:

```js
      expression: z.string().optional().describe('JS expression evaluated in page context, e.g. "window.app && app.ready" (condition=function; requires "Allow user scripts" toggle on the extension)'),
```

- [ ] **Step 3: Unit test**

Run: `npm run test:unit`
Expected: tutti PASS (i test asseriscono routing e parametri, non i testi — guard di regressione).

- [ ] **Step 4: Commit**

```bash
git add server/tools.js
git commit -m "docs: nota toggle Allow user scripts su execute_js e wait_for"
```

---

### Task 6: Privacy policy + landing + GitHub Pages

**Files:**
- Create: `docs/index.md`
- Create: `docs/privacy.md`
- Create: `docs/_config.yml`

**Interfaces:**
- Produces: URL pubblico `https://frsorrentino.github.io/chrome-bridge/privacy` — consumato dal form CWS (Task 7 e checklist Task 10).

- [ ] **Step 1: Crea docs/_config.yml**

```yaml
title: Chrome Bridge for Claude Code
description: 56 browser automation tools for Claude Code over a local WebSocket
theme: jekyll-theme-primer
exclude:
  - superpowers/
  - store/
```

- [ ] **Step 2: Crea docs/index.md**

```markdown
# Chrome Bridge for Claude Code

MCP server + Chrome extension that connect [Claude Code](https://claude.com/claude-code) to your real browser through a local WebSocket bridge. 56 web-development automation tools: navigation, DOM inspection, screenshots, visual regression, accessibility/SEO/security audits, network mocking.

Built for ChromeOS (Crostini), works on any platform with Chrome 135+. Fully self-hosted: no remote servers, no accounts, no data collection.

- [Source code and documentation (GitHub)](https://github.com/frsorrentino/chrome-bridge)
- [Privacy policy](./privacy)
```

- [ ] **Step 3: Crea docs/privacy.md**

```markdown
# Privacy Policy — Chrome Bridge for Claude Code

_Last updated: July 9, 2026_

## Summary

Chrome Bridge does not collect, store, transmit, sell, or share any user data. Everything stays on your machine.

## What the extension does

Chrome Bridge for Claude Code is a browser automation bridge. It executes commands (navigate, click, read the DOM, take screenshots, etc.) that **you** issue through the Claude Code CLI running on your own computer. Commands and results travel exclusively over a WebSocket connection to `localhost` (default port 8765) — a process on your own machine. The extension never communicates with any remote server.

## Data collection

- **No data is collected.** The extension has no analytics, no telemetry, no crash reporting, no tracking of any kind.
- **No data leaves your machine.** The only network endpoint the extension talks to is `ws://localhost:<port>` on your own computer.
- **No accounts.** The extension requires no sign-up, login, or personal information.

## Why the extension requests broad permissions

The extension asks for permissions such as `cookies`, `webRequest`, `clipboardRead`, `downloads`, and access to all websites (`<all_urls>`). These are required so that the automation commands you issue can operate on whatever page you point them at — for example reading a page's cookies to debug a login flow, mocking network requests, or taking a screenshot. The permissions are used **only** to execute your own commands, on your own browser, at your own request. The extension performs no background activity on its own.

## Arbitrary code execution

The `execute_js` tool runs JavaScript that you author via the `chrome.userScripts` API, which requires you to explicitly enable the "Allow user scripts" toggle in Chrome. This code originates from your own Claude Code session on your machine and is never fetched from a remote source.

## Changes

Any change to this policy will be published at this address and versioned in the [GitHub repository](https://github.com/frsorrentino/chrome-bridge).

## Contact

Questions: open an issue at <https://github.com/frsorrentino/chrome-bridge/issues>.
```

- [ ] **Step 4: Commit e push**

```bash
git add docs/_config.yml docs/index.md docs/privacy.md
git commit -m "docs: privacy policy + landing per GitHub Pages"
git push origin main
```

- [ ] **Step 5: Attiva GitHub Pages**

Run: `gh api repos/frsorrentino/chrome-bridge/pages -X POST -f "source[branch]=main" -f "source[path]=/docs" 2>&1 || gh api repos/frsorrentino/chrome-bridge/pages -X PUT -f "source[branch]=main" -f "source[path]=/docs"`
Expected: JSON di risposta con `"status"` (POST fallisce con 409 se Pages già attivo → il PUT aggiorna la source).

- [ ] **Step 6: Verifica URL raggiungibile**

Attendi il build (1-3 min), poi:
Run: `curl -sL -o /dev/null -w "%{http_code}" https://frsorrentino.github.io/chrome-bridge/privacy`
Expected: `200`. Se 404, riprova dopo 2 minuti (build Pages asincrono); dopo 10 minuti indaga con `gh api repos/frsorrentino/chrome-bridge/pages/builds/latest`.

---

### Task 7: Testi listing + giustificazioni permessi

**Files:**
- Create: `docs/store/listing.md`
- Create: `docs/store/permissions-justifications.md`

**Interfaces:**
- Produces: testi pronti da incollare nel form CWS — consumati dalla checklist (Task 10).

- [ ] **Step 1: Crea docs/store/listing.md**

```markdown
# Chrome Web Store listing — Chrome Bridge for Claude Code

## Name

Chrome Bridge for Claude Code

## Summary (max 132 chars)

Bridge your browser to Claude Code: 56 web-dev automation tools over a local WebSocket. Self-hosted, works on ChromeOS.

## Category

Developer Tools

## Language

English

## Single purpose statement

This extension has a single purpose: it lets the user's own Claude Code CLI (running locally on their machine) inspect and drive the user's browser for web development and testing. It executes only commands the user issues, received exclusively over a WebSocket connection to localhost, and performs no autonomous background activity.

## Detailed description

Chrome Bridge connects Claude Code — Anthropic's CLI coding agent — to your real, logged-in Chrome browser. No headless instance, no debugging port, no cloud service: a local WebSocket (localhost:8765) bridges the Claude Code MCP server on your machine to this extension.

56 specialized web-development tools:

• Navigation & tabs — open, close, navigate, list tabs
• DOM — query selectors (shadow-DOM piercing), read pages as markdown, list interactive elements, modify the DOM
• Input — click, type, press keys, fill forms, drag & drop, upload files
• Screenshots — viewport, element, full page, visual regression diff
• Audits — accessibility (WCAG), SEO, security headers, web vitals, unused CSS
• Network — monitor requests, mock/block/redirect, WebSocket monitoring, HAR export
• Debugging — console logs, JS execution, event listeners, performance metrics
• Emulation — media, geolocation, viewport, zoom

Built for ChromeOS (Crostini), where no other Claude Code browser automation works. Runs on any platform with Chrome 135+.

REQUIREMENTS

This extension is a companion to the open-source chrome-bridge MCP server and requires it to be installed and configured with Claude Code:
https://github.com/frsorrentino/chrome-bridge

The execute_js tool additionally requires enabling the "Allow user scripts" toggle in the extension's details page (chrome://extensions).

PRIVACY

Everything stays on your machine. The extension talks only to localhost — no remote servers, no analytics, no data collection. Privacy policy: https://frsorrentino.github.io/chrome-bridge/privacy

## URLs for the form

- Homepage: https://github.com/frsorrentino/chrome-bridge
- Support: https://github.com/frsorrentino/chrome-bridge/issues
- Privacy policy: https://frsorrentino.github.io/chrome-bridge/privacy

## Data usage disclosures (Privacy tab of the CWS form)

- "Does your extension collect or use any of the following user data?" → check NOTHING (no data collected).
- Certify: data is not sold, not used for unrelated purposes, not used for creditworthiness.
```

- [ ] **Step 2: Crea docs/store/permissions-justifications.md**

```markdown
# Permission justifications — CWS form (Privacy practices tab)

One paragraph per permission, ready to paste.

## tabs

Required to list open tabs (get_tabs tool), create/close/activate tabs, and resolve which tab an automation command targets. Core to every browser automation command the user issues.

## scripting

Required to inject the static, extension-bundled functions that implement DOM tools (query selectors, read page content, click, fill forms, take element measurements) into the page the user is automating.

## userScripts

Required by the execute_js and wait_for tools, which run JavaScript snippets authored by the user in their own Claude Code session. The userScripts API is used precisely as intended: executing user-authored scripts, gated behind Chrome's "Allow user scripts" toggle which the user must enable explicitly.

## alarms

Keeps the extension's service worker alive and schedules WebSocket reconnection attempts to the local bridge server. No user data involved.

## storage

Stores the extension's own settings locally: WebSocket port, optional authentication token, and the page-instrumentation on/off preference. Also used by the get_storage/set_storage debugging tools to read/write localStorage of the page under automation, at the user's request.

## cookies

Powers the get_storage/set_storage tools' cookie mode, letting the user inspect and set cookies of the site they are debugging (e.g. reproducing a login state). Only runs when the user issues the command; cookies are returned to the user's own local CLI and nowhere else.

## webNavigation

Detects page load and SPA route-change completion so navigation tools can report when a page is ready, and tracks frames for iframe-targeted commands.

## webRequest

Powers the network monitoring tools (monitor_network, HAR export, WebSocket monitoring): the user watches their own page's requests for debugging. Data is reported only to the user's local CLI.

## webRequestAuthProvider

Lets the http_auth tool answer HTTP Basic/Digest authentication challenges with credentials the user supplies, so automation can reach password-protected staging sites.

## declarativeNetRequest

Powers the network_rules tool: the user can block, redirect, or modify headers of requests on the page under test (e.g. mocking an API during development).

## clipboardRead / clipboardWrite

Power the clipboard tool, which lets the user read/write the clipboard as part of automation flows (e.g. verifying a "copy to clipboard" button works).

## downloads

Powers the manage_downloads tool (list, wait for completion) and save_page, so automation can verify file-download flows.

## pageCapture

Powers the save_page tool, which captures the current page as MHTML to the user's own disk for offline inspection.

## Host permission: <all_urls>

The extension is a general-purpose web-development automation bridge: the user points it at whatever site they are developing or testing (localhost apps, staging servers, production sites). The target is unknowable in advance, so access to all URLs is required. The extension acts only on explicit user commands received from localhost and performs no autonomous browsing.

## Remote code

No remote code. All executable code ships in the extension package. The execute_js tool runs user-authored snippets via the chrome.userScripts API (see userScripts justification); nothing is fetched from remote servers.
```

- [ ] **Step 3: Commit**

```bash
git add docs/store/listing.md docs/store/permissions-justifications.md
git commit -m "docs: testi listing CWS e giustificazioni permessi"
```

---

### Task 8: Script packaging + zip

**Files:**
- Create: `scripts/package-extension.sh`
- Modify: `.gitignore` (aggiungi `dist/`)

**Interfaces:**
- Consumes: `extension/manifest.json` (versione).
- Produces: `dist/chrome-bridge-extension-1.5.0.zip` con manifest in root — l'artefatto da caricare su CWS.

- [ ] **Step 1: Crea scripts/package-extension.sh**

```bash
#!/usr/bin/env bash
# Impacchetta extension/ in uno zip pronto per l'upload sul Chrome Web Store.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$ROOT/extension/manifest.json')).version)")
OUT="$ROOT/dist/chrome-bridge-extension-$VERSION.zip"

mkdir -p "$ROOT/dist"
rm -f "$OUT"

# Zip con manifest.json in root (richiesto da CWS): zippare il contenuto, non la cartella
cd "$ROOT/extension"
zip -r -X "$OUT" . -x "*.DS_Store" -x "*~"

echo "Creato: $OUT"
unzip -l "$OUT"
```

- [ ] **Step 2: Rendi eseguibile e aggiorna .gitignore**

```bash
chmod +x scripts/package-extension.sh
grep -qx "dist/" .gitignore || echo "dist/" >> .gitignore
```

- [ ] **Step 3: Esegui e verifica**

Run: `scripts/package-extension.sh`
Expected: `Creato: .../dist/chrome-bridge-extension-1.5.0.zip`; il listing di `unzip -l` mostra `manifest.json` in root (non `extension/manifest.json`), i 4 file JS, popup.html/css e `icons/` con le 3 icone.

- [ ] **Step 4: Commit**

```bash
git add scripts/package-extension.sh .gitignore
git commit -m "feat: script packaging zip estensione per CWS"
```

---

### Task 9: Screenshot store + promo tile

**Files:**
- Create: `docs/store/screenshots/screenshot-1.png` (1280×800) — popup connesso su una pagina reale
- Create: `docs/store/screenshots/screenshot-2.png` (1280×800) — tool in azione (es. highlight_elements o accessibility_audit su una pagina)
- Create: `docs/store/screenshots/screenshot-3.png` (1280×800) — sessione Claude Code che usa i tool (terminale)
- Create: `docs/store/promo-tile.html` (sorgente) e `docs/store/promo-tile-440x280.png`

**Interfaces:**
- Consumes: chrome-bridge funzionante (Task 2-4 completati, estensione ricaricata). Tool MCP `mcp__chrome-bridge__*` o CLI `server/cli.js`.
- Produces: PNG conformi ai formati CWS (screenshot 1280×800; promo tile 440×280).

Nota: task interattivo — richiede browser dell'utente. Se i tool `mcp__chrome-bridge__*` non sono nella sessione, usa la CLI (`node server/cli.js <comando>`).

- [ ] **Step 1: Prepara viewport 1280×800**

Usa `viewport_resize` (o CLI equivalente) a 1280×800, apri una pagina dimostrativa realistica (es. il repo GitHub del progetto o una pagina demo locale).

- [ ] **Step 2: Screenshot 1 — popup connesso**

Il popup non è catturabile via API di automazione. Chiedi all'utente di aprire il popup con l'estensione connessa e fare uno screenshot manuale della finestra (ChromeOS: Shift+Ctrl+Mostra finestre), oppure componi lo screenshot da una cattura della pagina con il popup renderizzato in una tab (`chrome-extension://<id>/popup.html` aperto come tab, zoom adeguato, su sfondo della pagina demo). Ridimensiona/croppa a 1280×800 esatti.

- [ ] **Step 3: Screenshot 2 — tool in azione**

Esegui `highlight_elements` su elementi interattivi di una pagina demo (o `accessibility_audit` con overlay), poi `screenshot` della viewport a 1280×800. Salva in `docs/store/screenshots/screenshot-2.png`.

- [ ] **Step 4: Screenshot 3 — Claude Code in azione**

Chiedi all'utente uno screenshot del terminale con una sessione Claude Code che usa chrome-bridge (o componi una pagina HTML che riproduce fedelmente il terminale e catturala a 1280×800).

- [ ] **Step 5: Promo tile 440×280**

Crea `docs/store/promo-tile.html`, aprila nel browser e cattura l'elemento `.tile` con `element_screenshot`:

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; }
  .tile {
    width: 440px; height: 280px; box-sizing: border-box;
    display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 12px;
    background: linear-gradient(135deg, #1a2332 0%, #2d4263 100%);
    font-family: system-ui, sans-serif; color: #fff;
  }
  .tile img { width: 96px; height: 96px; }
  .tile h1 { margin: 0; font-size: 26px; font-weight: 700; }
  .tile p { margin: 0; font-size: 14px; color: #9db4d0; }
</style></head><body>
  <div class="tile">
    <img src="../../extension/icons/icon-128.png" alt="">
    <h1>Chrome Bridge</h1>
    <p>56 browser tools for Claude Code</p>
  </div>
</body></html>
```

Verifica dimensioni: `node -e "const b=require('fs').readFileSync('docs/store/promo-tile-440x280.png'); console.log(b.readUInt32BE(16), 'x', b.readUInt32BE(20))"` → `440 x 280`.

- [ ] **Step 6: Verifica dimensioni screenshot**

Run (per ciascun file): `node -e "const b=require('fs').readFileSync(process.argv[1]); console.log(b.readUInt32BE(16), 'x', b.readUInt32BE(20))" docs/store/screenshots/screenshot-1.png`
Expected: `1280 x 800` per tutti gli screenshot.

- [ ] **Step 7: Commit**

```bash
git add docs/store/screenshots/ docs/store/promo-tile.html docs/store/promo-tile-440x280.png
git commit -m "docs: screenshot store 1280x800 e promo tile 440x280"
```

---

### Task 10: Checklist submission

**Files:**
- Create: `docs/store/submission-checklist.md`

**Interfaces:**
- Consumes: zip (Task 8), testi (Task 7), URL privacy (Task 6), asset (Task 9).

- [ ] **Step 1: Crea docs/store/submission-checklist.md**

```markdown
# Checklist submission Chrome Web Store

## 0. Prerequisiti (una tantum)

- [ ] Account Google da usare come developer (consigliato: quello personale principale)
- [ ] Registrazione su https://chrome.google.com/webstore/devconsole → accetta il Developer Agreement → paga $5 (carta richiesta)
- [ ] (Consigliato) In "Account" compila publisher name ed email di contatto, verifica l'email

## 1. Upload pacchetto

- [ ] Genera lo zip: `scripts/package-extension.sh` → `dist/chrome-bridge-extension-1.5.0.zip`
- [ ] Dev Console → "New item" → carica lo zip

## 2. Tab "Store listing"

Da `docs/store/listing.md`:
- [ ] Title: Chrome Bridge for Claude Code
- [ ] Summary: (riga Summary)
- [ ] Description: (sezione Detailed description)
- [ ] Category: Developer Tools · Language: English
- [ ] Screenshot: carica i 3 PNG 1280×800 da `docs/store/screenshots/`
- [ ] Small promo tile 440×280: `docs/store/promo-tile-440x280.png`
- [ ] Homepage URL e Support URL (sezione URLs)

## 3. Tab "Privacy practices"

- [ ] Single purpose: incolla da `docs/store/listing.md`
- [ ] Permission justifications: incolla ogni voce da `docs/store/permissions-justifications.md` (inclusa host permission e remote code)
- [ ] Data usage: nessuna categoria selezionata + spunta le 3 certificazioni
- [ ] Privacy policy URL: https://frsorrentino.github.io/chrome-bridge/privacy

## 4. Tab "Distribution"

- [ ] Visibility: Public
- [ ] Distribution: tutti i paesi (default)

## 5. Submit

- [ ] "Submit for review". Non spuntare la pubblicazione differita (publish automatically appena approvato va bene)
- [ ] Tempi attesi: da ore a ~1-2 settimane (permessi ampi = coda review manuale)

## 6. Se arriva un rigetto

- Leggi il motivo esatto nell'email (codice violazione, es. "Blue Argon" = remote code, "Purple Potassium" = permessi non giustificati)
- Rispondi/correggi e risottometti: i rigetti al primo giro sono normali per estensioni con permessi ampi
- Non ricreare l'item da zero: risottometti lo stesso, la storia review aiuta
```

- [ ] **Step 2: Commit**

```bash
git add docs/store/submission-checklist.md
git commit -m "docs: checklist submission CWS passo-passo"
```

---

### Task 11: Verifica finale

**Files:** nessuno nuovo.

- [ ] **Step 1: Grep policy-compliance**

Run: `grep -rn "eval(\|new Function\|importScripts" extension/`
Expected: nessun output.

- [ ] **Step 2: Suite completa**

Run: `npm run test:unit`
Expected: tutti PASS.

Run: `node test/test-devtools.js` (prerequisiti del Task 3, Step 4)
Expected: tutti PASS.

- [ ] **Step 3: Coerenza versioni**

Run: `node -e "const m=JSON.parse(require('fs').readFileSync('extension/manifest.json')); const p=JSON.parse(require('fs').readFileSync('package.json')); console.log(m.version, p.version, m.minimum_chrome_version, m.permissions.includes('userScripts'))"`
Expected: `1.5.0 1.5.0 135 true`

- [ ] **Step 4: Rigenera zip finale**

Run: `scripts/package-extension.sh`
Expected: zip 1.5.0 rigenerato con i sorgenti definitivi.

- [ ] **Step 5: Privacy URL live**

Run: `curl -sL -o /dev/null -w "%{http_code}" https://frsorrentino.github.io/chrome-bridge/privacy`
Expected: `200`

- [ ] **Step 6: Push finale**

```bash
git push origin main
```

Consegna all'utente: percorso zip, link checklist (`docs/store/submission-checklist.md`), promemoria registrazione account $5.
