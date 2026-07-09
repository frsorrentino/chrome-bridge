# Foglio copia-incolla — submission CWS nell'ordine esatto del form

Apri https://chrome.google.com/webstore/devconsole → **+ New item** → trascina `dist/chrome-bridge-extension-1.5.0.zip`.
Poi segui questo foglio dall'alto in basso. Ogni blocco tra righe ``` va incollato integro.

---

## TAB "Store listing"

**Title** (precompilato dal manifest, verifica):

```
Chrome Bridge for Claude Code
```

**Summary** (precompilato dal manifest, verifica):

```
Bridge your browser to Claude Code: 56 web-dev automation tools over a local WebSocket. Self-hosted, works on ChromeOS.
```

**Description:**

```
Chrome Bridge connects Claude Code — Anthropic's CLI coding agent — to your real, logged-in Chrome browser. No headless instance, no debugging port, no cloud service: a local WebSocket (localhost:8765) bridges the Claude Code MCP server on your machine to this extension.

56 specialized web-development tools:

• Navigation & tabs — open, close, navigate, list tabs
• DOM — query selectors (shadow-DOM piercing), read pages as markdown, list interactive elements, modify the DOM
• Input — click, type, press keys, fill forms, drag & drop, upload files
• Screenshots — viewport, element, full page, visual regression diff; captures run in the background without stealing window focus
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
```

**Category:** Developer Tools
**Language:** English

**Store icon:** già nello zip (128px), se richiesto ricarica `extension/icons/icon-128.png`

**Screenshots** (3 file, 1280×800): `docs/store/screenshots/screenshot-1.png`, `screenshot-2.png`, `screenshot-3.png`

**Small promo tile** (440×280): `docs/store/promo-tile-440x280.png`

**Homepage URL:**

```
https://github.com/frsorrentino/chrome-bridge
```

**Support URL:**

```
https://github.com/frsorrentino/chrome-bridge/issues
```

---

## TAB "Privacy"

**Single purpose:**

```
This extension has a single purpose: it lets the user's own Claude Code CLI (running locally on their machine) inspect and drive the user's browser for web development and testing. It executes only commands the user issues, received exclusively over a WebSocket connection to localhost, and performs no autonomous background activity.
```

### Permission justifications (un campo per permesso)

**tabs:**

```
Required to list open tabs (get_tabs tool), create/close/activate tabs, and resolve which tab an automation command targets. Core to every browser automation command the user issues.
```

**scripting:**

```
Required to inject the static, extension-bundled functions that implement DOM tools (query selectors, read page content, click, fill forms, take element measurements) into the page the user is automating.
```

**userScripts:**

```
Required by the execute_js and wait_for tools, which run JavaScript snippets authored by the user in their own Claude Code session. The userScripts API is used precisely as intended: executing user-authored scripts, gated behind Chrome's "Allow user scripts" toggle which the user must enable explicitly.
```

**alarms:**

```
Keeps the extension's service worker alive and schedules WebSocket reconnection attempts to the local bridge server. No user data involved.
```

**storage:**

```
Stores the extension's own settings locally: WebSocket port, optional authentication token, and the page-instrumentation on/off preference. Also used by the get_storage/set_storage debugging tools to read/write localStorage of the page under automation, at the user's request.
```

**cookies:**

```
Powers the get_storage/set_storage tools' cookie mode, letting the user inspect and set cookies of the site they are debugging (e.g. reproducing a login state). Only runs when the user issues the command; cookies are returned to the user's own local CLI and nowhere else.
```

**webNavigation:**

```
Detects page load and SPA route-change completion so navigation tools can report when a page is ready, and tracks frames for iframe-targeted commands.
```

**webRequest:**

```
Powers the network monitoring tools (monitor_network, HAR export, WebSocket monitoring): the user watches their own page's requests for debugging. Data is reported only to the user's local CLI.
```

**webRequestAuthProvider:**

```
Lets the http_auth tool answer HTTP Basic/Digest authentication challenges with credentials the user supplies, so automation can reach password-protected staging sites.
```

**declarativeNetRequest:**

```
Powers the network_rules tool: the user can block, redirect, or modify headers of requests on the page under test (e.g. mocking an API during development).
```

**clipboardRead / clipboardWrite:**

```
Power the clipboard tool, which lets the user read/write the clipboard as part of automation flows (e.g. verifying a "copy to clipboard" button works).
```

**downloads:**

```
Powers the manage_downloads tool (list, wait for completion) and save_page, so automation can verify file-download flows.
```

**pageCapture:**

```
Powers the save_page tool, which captures the current page as MHTML to the user's own disk for offline inspection.
```

**Host permission (<all_urls>):**

```
The extension is a general-purpose web-development automation bridge: the user points it at whatever site they are developing or testing (localhost apps, staging servers, production sites). The target is unknowable in advance, so access to all URLs is required. The extension acts only on explicit user commands received from localhost and performs no autonomous browsing.
```

**Remote code** (se chiesto "Are you using remote code?" → **No** + giustificazione):

```
No remote code. All executable code ships in the extension package. The execute_js tool runs user-authored snippets via the chrome.userScripts API (see userScripts justification); nothing is fetched from remote servers.
```

### Data usage

- Sezione "What user data do you plan to collect?": **NON selezionare nulla**
- Spunta le 3 certificazioni ("I do not sell or transfer user data...", ecc.)

**Privacy policy URL** (in Account o nel campo dedicato):

```
https://frsorrentino.github.io/chrome-bridge/privacy
```

---

## TAB "Distribution"

- **Visibility:** Public
- **Distribution:** All regions (default)

---

## Submit

- Salva bozza → **Submit for review**
- Lascia attiva la pubblicazione automatica post-approvazione
- Tempi: da ore a 1-2 settimane (permessi ampi = review manuale). Primo rigetto = normale: leggi il codice violazione nell'email, correggi/rispondi, risottometti lo stesso item.
