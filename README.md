# Chrome Bridge

**MCP server that connects Claude Code to Chrome through a WebSocket bridge and a Chrome extension.** Built for ChromeOS (Crostini), works on any platform with Chrome 111+.

Chrome Bridge drives your real, logged-in browser — no headless instance, no CDP debugging port, no paid plan. It exposes 56 specialized web-development tools (navigation, DOM inspection, visual regression, audits, network mocking) over a single local WebSocket.

## Why Chrome Bridge?

There are several browser automation tools for Claude Code. Here's how they compare:

| | Chrome Bridge | Claude in Chrome | Chrome DevTools MCP | Playwright MCP |
|---|---|---|---|---|
| **ChromeOS / Crostini** | **Yes** | No | No | No |
| **Connection** | WebSocket | Native Messaging | CDP (`--remote-debugging-port`) | Separate browser instance |
| **Tools** | **56** | ~15 | Full CDP | ~20 |
| **Uses your real browser** | Yes | Yes | Yes (with flags) | No (isolated session) |
| **Shares your logins** | Yes | Yes | Yes | No |
| **Requires paid plan** | No | Yes (Pro/Max/Team) | No | No |
| **DevTools** (perf, network, DOM) | **Yes** | No | Yes (full) | No |
| **A11y / SEO / security audits** | **Yes** | No | No | No |
| **Media emulation** | Yes | No | Yes | Yes |
| **Dialog handling** (JS dialogs) | Yes | Yes | Yes | Yes |
| **Network mocking** | **Yes** (block/redirect/headers) | No | No | No |
| **Visual regression** | **Yes** (`screenshot_diff`) | No | No | No |
| **Shadow DOM + iframe** | **Yes** | No | Partial | Yes |
| **GIF recording** | No | Yes | No | No |
| **Breakpoints / profiling** | No | No | Yes | No |
| **Headless / CI** | No | No | No | Yes |

**In short:** Chrome Bridge is the only option that works on ChromeOS, ships 56 specialized web-development tools, and runs entirely self-hosted with no paid plan. The tradeoff is no GIF recording, no CDP-level debugging (breakpoints/profiling), and no headless mode.

## Architecture

```
Claude Code  <--stdio-->  MCP Server  <--WebSocket :8765-->  Chrome Extension
                          (server/)                          (extension/, MV3)
```

- **MCP Server** (`server/`): Node.js. Talks to Claude Code over stdio and to the extension over a WebSocket. When the port is already held by a primary instance, additional MCP processes attach as loopback relay clients.
- **Chrome Extension** (`extension/`): Manifest V3. Executes commands with Chrome APIs and returns results. Ships with a bridge-themed icon (16/48/128px).
- Page scripts run via `chrome.scripting.executeScript` in the **MAIN world**. `chrome.debugger` is **not** used (it is broken on ChromeOS).

## Tools (56)

### Core & navigation (7)
| Tool | Description |
|------|-------------|
| `get_status` | Bridge status: extension connection, server mode (primary/relay), port, version, uptime |
| `get_tabs` | List all open Chrome tabs |
| `create_tab` | Create a new tab, optionally navigating to a URL |
| `navigate` | Navigate a tab to a URL |
| `tab_action` | Tab lifecycle: close, activate, reload (optional cache bypass), back, forward |
| `get_frames` | List all frames (main + iframes) with `frameId` for frame targeting |
| `screenshot` | Capture the visible tab as PNG (brings the tab to foreground) |

### Interaction (12)
| Tool | Description |
|------|-------------|
| `click` | Click an element by CSS selector; occlusion-checked, optional `wait_after` |
| `type_text` | Type into an input: `set` (assign value) or `keys` (per-character key events) |
| `fill_form` | Batch-fill form fields with React-compatible events; optional submit + `wait_after` |
| `hover` | Hover over an element (dispatches mouseenter/mouseover) |
| `press_key` | Press a key with modifiers (Ctrl/Shift/Alt/Meta) |
| `scroll` | `action=to`: scroll to element/coordinates with header offset; `action=until`: scroll repeatedly until element appears, network idles, or content stops loading |
| `drag_and_drop` | Drag one element onto another: HTML5 `DragEvent` mode or pointer-event mode |
| `upload_file` | Set a file on `input[type=file]` from the server filesystem via DataTransfer (max 10MB) |
| `dismiss_overlays` | Dismiss cookie-consent banners / modals (OneTrust, Cookiebot, Usercentrics + heuristic) |
| `handle_dialogs` | Auto-accept/dismiss JS dialogs (alert/confirm/prompt) with a log of intercepted ones |
| `clipboard` | Read or write the system clipboard (text) |

### DOM & inspection (10)
| Tool | Description |
|------|-------------|
| `read_page` | Read page content as text, full HTML, or accessibility tree |
| `get_page_info` | Page metadata: meta tags, scripts, stylesheets, links, forms |
| `query_dom` | Query elements: structure, attributes, bounding rect, computed styles |
| `modify_dom` | Set/remove attributes, classes, styles, text content |
| `find_text` | Find text occurrences with parent selector, context, visibility, page position |
| `get_interactives` | List actionable elements (buttons, links, inputs, `[role]`, `[onclick]`) with ready-to-use selectors |
| `inject_css` | Inject CSS rules into a tab |
| `highlight_elements` | Add a colored overlay on matching elements (with optional labels) |
| `watch_dom` | MutationObserver for attribute / childList / characterData changes |
| `measure_spacing` | Pixel distance, gap, overlap, margin/padding between two elements |

### Waiting (1)
| Tool | Description |
|------|-------------|
| `wait_for` | One tool, four conditions: `element` (selector appears), `function` (JS expression truthy), `navigation` (page load or `mode=spa` route change), `network_idle` (no XHR/fetch in flight) |

### Debugging & network (8)
| Tool | Description |
|------|-------------|
| `execute_js` | Execute JavaScript in page context (per-frame targeting) |
| `read_console` | Console messages captured from page load, incl. uncaught errors and unhandled rejections |
| `monitor_network` | Monitor requests: `page` (XHR/fetch hook) or `browser` (all, incl. static assets); HAR 1.2 export |
| `monitor_websocket` | Monitor WebSocket connections and messages (both directions, 500-char previews) |
| `network_rules` | Block requests, redirect URLs (mock an API), set/remove request headers (`declarativeNetRequest`) |
| `get_performance` | Navigation timing, paint metrics, memory, resource loading |
| `web_vitals` | Core Web Vitals since page load: CLS, LCP, FCP, TTFB, long tasks, INP approximation |
| `list_event_listeners` | `addEventListener` registrations since page load, with counts by type |

### Visual & responsive (7)
| Tool | Description |
|------|-------------|
| `element_screenshot` | Screenshot of a single element, cropped via OffscreenCanvas |
| `full_page_screenshot` | Scroll-and-capture full page, stitched into one PNG (or one image per viewport) |
| `screenshot_diff` | Visual regression: named baselines, changed-pixel percentage, red-overlay diff image |
| `viewport_resize` | Resize the window to a preset (mobile/tablet/desktop) or custom size |
| `set_zoom` | Get/set the tab zoom factor (0.25–5) |
| `emulate_media` | Override prefers-color-scheme, reduced-motion, print mode |
| `set_geolocation` | Override `navigator.geolocation` with fixed coordinates |

### Audits (6)
| Tool | Description |
|------|-------------|
| `accessibility_audit` | Missing alt, empty links, heading hierarchy, ARIA, contrast (approximate), form labels |
| `seo_audit` | Title/description lengths, canonical, robots, h1 count, Open Graph, Twitter card, JSON-LD, hreflang, favicon |
| `security_headers` | HTTP security headers: CSP, HSTS, X-Content-Type-Options, clickjacking, Referrer/Permissions-Policy, version leaks |
| `check_links` | Find broken links — collected in the page, verified server-side (no CORS limits) |
| `unused_css` | CSS selectors with no matching element in the current DOM (approximate) |
| `extract_table` | Extract an HTML table as structured JSON (headers + row objects) |

### State & storage (4)
| Tool | Description |
|------|-------------|
| `get_storage` | Read localStorage, sessionStorage, cookies (incl. HttpOnly via `chrome.cookies`) |
| `set_storage` | Write/delete/clear localStorage, sessionStorage, or cookies |
| `session_fixture` | Save/restore localStorage + sessionStorage + cookies as a named, origin-guarded fixture |
| `http_auth` | Provide credentials for HTTP Basic/Digest auth dialogs (browser-wide, in-memory) |

### Capture & files (2)
| Tool | Description |
|------|-------------|
| `save_page` | Save the full page (DOM, styles, images) as an MHTML archive on the server filesystem |
| `manage_downloads` | List recent downloads or wait for an in-progress/new download to complete |

## Security

Every WebSocket connection must identify itself within **5 seconds** or it is terminated.

- **Extension** sends `ext_init` — accepted only if the request `Origin` is `chrome-extension://…`. Random web pages cannot connect: browsers force the real page origin in the `Origin` header.
- **Relay clients** (secondary MCP instances) send `relay_init` — accepted only from loopback (`127.0.0.1` / `::1`). When the port is already held by a primary server, additional MCP processes connect as relays and forward commands through it.
- Unidentified connections are dropped after the 5-second handshake window.
- **Optional shared token:** set `CHROME_BRIDGE_TOKEN` on the server and the matching value in the extension popup's Token field; mismatched `ext_init` is rejected.

> **Crostini caveat:** the server binds `0.0.0.0` so the ChromeOS-side browser can reach the Linux-container server. On a multi-user or untrusted network, set `CHROME_BRIDGE_TOKEN` — the origin check alone does not gate other machines on the LAN.

## Install

Requires **Node.js 18+** and **Chrome 111+**.

### From source

```bash
git clone git@github.com:frsorrentino/chrome-bridge.git
cd chrome-bridge
./install.sh
```

`install.sh` installs dependencies and registers the MCP server in Claude Code (`--scope user`), then prints the extension-loading steps.

### Manual setup

```bash
# 1. Install dependencies
npm install

# 2. Load the Chrome extension
#    - Open chrome://extensions
#    - Enable "Developer mode"
#    - Click "Load unpacked" and select the extension/ folder

# 3. Register the MCP server in Claude Code
claude mcp add --scope user chrome-bridge node /full/path/to/chrome-bridge/server/index.js
```

Restart Claude Code after loading the extension. The extension popup shows live connection status; you can also call `get_status`.

## Configuration

The extension popup has **Port** and **Token** fields (persisted in `chrome.storage.local`) — set them to match the server. Configure the server via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CHROME_BRIDGE_PORT` | `8765` | WebSocket server port |
| `CHROME_BRIDGE_TOKEN` | _(none)_ | Optional shared secret; when set, the extension must send the same token (popup Token field) |

## Selected capabilities

- **Shadow DOM piercing:** selector tools accept the `>>>` combinator (e.g. `my-app >>> button.save`).
- **iframe targeting:** DOM tools take a `frame_id` parameter — discover frames with `get_frames`.
- **Action waits:** `click`, `type_text`, and `fill_form` accept `wait_after` (`navigation` / `networkidle`) to chain interactions.
- **Click hardening:** `click` checks for occlusion before acting (override with `force`).
- **SPA awareness:** `wait_for` (`condition=navigation`, `mode=spa`) resolves on `history.pushState` / `popstate` / `hashchange`.
- **Early console capture:** an opt-in content script at `document_start` records console output, uncaught errors, and unhandled promise rejections before any tool call. It is registered dynamically and toggled by the popup's "Capture page console & metrics" checkbox (default on) — turn it off for zero page footprint on heavy apps.
- **Full-page screenshots in readable segments:** viewport captures are stitched then sliced into ~2-viewport segments, each downscaled to ≤1568px on the long side (what LLM clients render anyway).
- **Server-side link checking:** `check_links` verifies URLs from the server, so external links get real HTTP statuses without CORS limits.
- **HttpOnly cookies:** read/written via `chrome.cookies`, so HttpOnly cookies are visible.
- **HAR export:** `monitor_network` can emit HAR 1.2.
- **Timeouts:** 120s `full_page_screenshot`; 60s for waits, `upload_file`, `manage_downloads`, `save_page`; 10s screenshots; 30s for everything else.

## Tests

```bash
# Unit tests — 20 tests, no Chrome needed (protocol, ws-manager, link-checker, HAR, security-headers)
npm run test:unit

# End-to-end suite — requires the extension loaded and the bridge port free
node test/test-devtools.js
```

The e2e script starts its own WebSocket server, opens a test tab, and exercises the tools against it. Stop any running MCP server on the port first.

## Project structure

```
chrome-bridge/
  server/
    index.js                # Entry point: MCP server + WebSocket
    protocol.js             # Message types, version, timeouts, command builder
    tools.js                # 56 MCP tool registrations (Zod schemas)
    ws-manager.js           # WebSocket server, handshake, relay mode
    link-checker.js         # Server-side link verification (check_links)
    har.js                  # HAR 1.2 export (monitor_network)
    security-headers.js     # Security-header analysis (security_headers)
  extension/
    manifest.json           # Chrome MV3 manifest (min Chrome 111)
    service-worker.js       # Command handlers, Chrome APIs
    console-capture.js      # Content script (dynamic, toggleable): console + error capture at document_start
    page-instrumentation.js # Content script: web vitals + event-listener tracking
    popup.html / .js / .css # Connection status popup (port + token settings)
    icons/                  # Extension icons (16/48/128px)
  test/
    unit/                   # Unit tests (node --test, no Chrome)
    test-devtools.js        # End-to-end suite (needs Chrome + extension)
  install.sh
```

## License

MIT
