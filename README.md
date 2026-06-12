# Chrome Bridge

MCP server that connects Claude Code to Chrome via a WebSocket bridge and a Chrome extension. Built for ChromeOS (Crostini), works on any platform with Chrome.

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
| **DevTools** (perf, network, DOM) | Yes | No | Yes (full) | No |
| **A11y / SEO / security audits** | Yes | No | No | No |
| **Media emulation** | Yes | No | Yes | Yes |
| **Network mocking** | **Yes** (block/redirect/headers) | No | No | No |
| **Visual regression** | **Yes** (`screenshot_diff`) | No | No | No |
| **Dialog handling** | Yes (JS dialogs) | Yes | Yes | Yes |
| **GIF recording** | No | Yes | No | No |
| **Breakpoints / profiling** | No | No | Yes | No |
| **Headless / CI** | No | No | No | Yes |

**In short**: Chrome Bridge is the only option that works on ChromeOS, has 56 specialized web development tools, and runs entirely self-hosted with no paid plan required. The tradeoff is no GIF recording, no CDP-level debugging (breakpoints/profiling), and no headless mode.

## Architecture

```
Claude Code <--stdio--> MCP Server <--WebSocket:8765--> Chrome Extension
```

- **MCP Server** (`server/`): Node.js, communicates with Claude Code via stdio and with the extension via WebSocket
- **Chrome Extension** (`extension/`): Manifest V3, executes commands using Chrome APIs and returns results
- All page scripts run via `chrome.scripting.executeScript` (MAIN world). No `chrome.debugger` (broken on ChromeOS).

## Tools (56)

### Core (11)
| Tool | Description |
|------|-------------|
| `get_status` | Bridge status: extension connection, server mode (primary/relay), port, version |
| `get_tabs` | List all open Chrome tabs |
| `navigate` | Navigate a tab to a URL |
| `screenshot` | Capture visible tab as PNG (brings tab to foreground) |
| `execute_js` | Execute JavaScript in page context (ISOLATED world, MAIN fallback) |
| `click` | Click an element by CSS selector (shadow DOM piercing with `>>>`) |
| `type_text` | Type text into an input element |
| `read_page` | Read page content (text, HTML, or accessibility tree) |
| `create_tab` | Create a new tab, optionally with a URL |
| `tab_action` | Tab lifecycle: close, activate, reload (cache bypass), back, forward |
| `get_frames` | List all frames (main + iframes) with frameId for frame targeting |

### DevTools (14)
| Tool | Description |
|------|-------------|
| `get_page_info` | Get meta tags, scripts, stylesheets, links, forms |
| `get_storage` | Read localStorage, sessionStorage, cookies (incl. HttpOnly via `chrome.cookies`) |
| `set_storage` | Write/delete/clear localStorage, sessionStorage, cookies |
| `get_performance` | Navigation timing, paint metrics, memory, resources |
| `web_vitals` | Core Web Vitals since page load: CLS, LCP, FCP, TTFB, long tasks, INP approximation |
| `query_dom` | Query elements with attributes, rect, computed styles |
| `modify_dom` | Set/remove attributes, classes, styles, text content |
| `inject_css` | Inject CSS rules into a tab |
| `read_console` | Console messages captured from page load, incl. uncaught errors and unhandled rejections |
| `monitor_network` | Monitor requests: page hook (XHR/fetch) or `webRequest` (all, incl. static assets); HAR 1.2 export |
| `monitor_websocket` | Monitor WebSocket connections and messages (both directions, 500-char previews) |
| `list_event_listeners` | List `addEventListener` registrations since page load, with counts by type |
| `network_rules` | Block requests, redirect URLs (mock API endpoints), set/remove request headers (`declarativeNetRequest`) |
| `http_auth` | Provide credentials for HTTP Basic/Digest auth dialogs |

### Navigation & Forms (12)
| Tool | Description |
|------|-------------|
| `wait_for_element` | Poll until a selector appears (with optional visibility check) |
| `wait_for_navigation` | Wait for the tab to finish navigating (status complete) |
| `wait_for_network_idle` | Wait until no XHR/fetch requests are in flight for a quiet period |
| `scroll_to` | Scroll to element or coordinates, with offset for fixed headers |
| `fill_form` | Batch fill form fields with React-compatible events |
| `upload_file` | Set a file on `input[type=file]` from the server filesystem via DataTransfer (max 10MB) |
| `drag_and_drop` | Drag element onto another: HTML5 DragEvent mode or pointer-event mode |
| `press_key` | Press a keyboard key with modifiers (Ctrl/Shift/Alt/Meta) |
| `hover` | Hover over an element (mouseenter/mouseover) |
| `handle_dialogs` | Auto-accept/dismiss JS dialogs (alert/confirm/prompt) with a log of intercepted ones |
| `find_text` | Find text occurrences with parent selector, context, visibility, page position |
| `clipboard` | Read or write the system clipboard (text) |

### Visual & Responsive (8)
| Tool | Description |
|------|-------------|
| `viewport_resize` | Resize window to preset (mobile/tablet/desktop) or custom size |
| `full_page_screenshot` | Scroll-and-capture full page, stitched into a single PNG by default |
| `element_screenshot` | Screenshot of a single element, cropped via OffscreenCanvas |
| `screenshot_diff` | Visual regression: named baselines, changed-pixel percentage, red-overlay diff image |
| `highlight_elements` | Add colored overlay on matching elements |
| `set_zoom` | Get/set the tab zoom factor (0.25–5) |
| `emulate_media` | Override prefers-color-scheme, reduced-motion, print mode |
| `set_geolocation` | Override `navigator.geolocation` with fixed coordinates |

### Analysis (8)
| Tool | Description |
|------|-------------|
| `accessibility_audit` | Audit for missing alt, empty links, heading hierarchy, ARIA, contrast, form labels |
| `seo_audit` | Title/description lengths, canonical, robots, h1 count, Open Graph, JSON-LD, hreflang, favicon |
| `security_headers` | Audit HTTP security headers: CSP, HSTS, X-Content-Type-Options, clickjacking, Referrer-Policy |
| `check_links` | Find broken links — collected in the page, verified server-side (no CORS limits) |
| `measure_spacing` | Measure pixel distance, gap, overlap, margin/padding between two elements |
| `unused_css` | Find CSS selectors with no matching element in the current DOM (approximate) |
| `extract_table` | Extract an HTML table as structured JSON (headers + row objects) |
| `watch_dom` | MutationObserver for attribute/childList/characterData changes |

### Session & Capture (3)
| Tool | Description |
|------|-------------|
| `session_fixture` | Save/restore localStorage + sessionStorage + cookies as a named fixture (origin-guarded) |
| `save_page` | Save the full page (DOM, styles, images) as an MHTML archive on the server filesystem |
| `manage_downloads` | List recent downloads or wait for an in-progress/new download to complete |

## Install

### From npm

```bash
npm install -g chrome-bridge-mcp
```

### From source

```bash
git clone git@github.com:frsorrentino/chrome-bridge.git
cd chrome-bridge
./install.sh
```

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

## Usage

Once installed, the tools are available in Claude Code automatically. The extension connects to the MCP server via WebSocket (default port 8765).

Check connection status via the extension popup icon or by calling the `get_status` tool.

### Configuration

The extension popup has **Port** and **Token** fields (persisted in `chrome.storage.local`) — the port is no longer hardcoded. Set them to match the server's environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CHROME_BRIDGE_PORT` | `8765` | WebSocket server port |
| `CHROME_BRIDGE_TOKEN` | _(none)_ | Optional shared secret; if set, the extension must send the same token in the popup's Token field |

## Security

Every WebSocket connection must identify itself within 5 seconds or it is terminated:

- The extension sends `ext_init` — accepted only if the request `Origin` is `chrome-extension://...`. Random web pages cannot connect (browsers force the real page origin in the `Origin` header).
- Secondary server instances send `relay_init` — accepted only from loopback (`127.0.0.1`/`::1`). When the port is already taken by a primary server, additional MCP processes connect as relay clients and forward commands through the primary.
- If `CHROME_BRIDGE_TOKEN` is set on the server, `ext_init` must carry the matching token (configured in the extension popup) or the connection is rejected.

## Tests

```bash
# Unit tests (20 tests, no Chrome needed): protocol, ws-manager, link-checker, HAR, security-headers
npm run test:unit

# End-to-end suite (23 tests): requires the extension loaded and the bridge port free
node test/test-devtools.js
```

The e2e script starts its own WebSocket server, creates a test tab on `example.com`, and exercises the tools against it. Stop any running MCP server on the port first.

## Project Structure

```
chrome-bridge/
  server/
    index.js                # Entry point: MCP server + WebSocket
    protocol.js             # Message types, timeouts, command builder
    tools.js                # MCP tool registrations (Zod schemas)
    ws-manager.js           # WebSocket server manager, handshake, relay mode
    link-checker.js         # Server-side link verification (check_links)
    har.js                  # HAR 1.2 export (monitor_network)
    security-headers.js     # Security header analysis (security_headers)
  extension/
    manifest.json           # Chrome MV3 manifest
    service-worker.js       # Command handlers, Chrome APIs
    console-capture.js      # Content script: console + error capture at document_start
    page-instrumentation.js # Content script: web vitals + event listener tracking
    popup.html/js/css       # Connection status popup (port + token settings)
    icons/                  # Extension icons
  test/
    unit/                   # Unit tests (node --test, no Chrome needed)
    test-devtools.js        # End-to-end test suite (23 tests)
```

## Technical Notes

- `execute_js` uses ISOLATED world by default (bypasses page CSP), with MAIN world fallback
- `chrome.debugger` is not used (doesn't work on ChromeOS); minimum Chrome version is 111
- Selector-based tools support shadow DOM piercing with the `>>>` combinator (e.g. `my-app >>> button.save`)
- DOM tools accept a `frame_id` parameter to target iframes — list frames with `get_frames`
- Console capture runs as a content script at `document_start`, so it catches early messages, uncaught errors, and unhandled promise rejections without any prior tool call
- Stateful hooks (`monitor_network` page source, `monitor_websocket`, `watch_dom`) inject on first call and auto-cleanup on tab navigation/close
- `full_page_screenshot` stitches viewport captures into one PNG by default (Chrome's ~16384px canvas side limit caps very tall pages); `stitch=false` returns one image per viewport
- `check_links` verifies URLs server-side, so external links get real HTTP statuses with no CORS limits
- Cookies are read/written via `chrome.cookies`, so HttpOnly cookies are visible
- Timeouts: 120s `full_page_screenshot`; 60s waits, `upload_file`, `manage_downloads`, `save_page`; 10s screenshots; 30s everything else

## License

MIT
