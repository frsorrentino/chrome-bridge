# Chrome Bridge

MCP server that connects Claude Code to Chrome via a WebSocket bridge and a Chrome extension. Built for ChromeOS (Crostini), works on any platform with Chrome.

## Why Chrome Bridge?

There are several browser automation tools for Claude Code. Here's how they compare:

| | Chrome Bridge | Claude in Chrome | Chrome DevTools MCP | Playwright MCP |
|---|---|---|---|---|
| **ChromeOS / Crostini** | **Yes** | No | No | No |
| **Connection** | WebSocket | Native Messaging | CDP (`--remote-debugging-port`) | Separate browser instance |
| **Tools** | **31** | ~15 | Full CDP | ~20 |
| **Uses your real browser** | Yes | Yes | Yes (with flags) | No (isolated session) |
| **Shares your logins** | Yes | Yes | Yes | No |
| **Requires paid plan** | No | Yes (Pro/Max/Team) | No | No |
| **DevTools** (perf, network, DOM) | Yes | No | Yes (full) | No |
| **A11y audit** | Yes | No | No | No |
| **Media emulation** | Yes | No | Yes | Yes |
| **GIF recording** | No | Yes | No | No |
| **Breakpoints / profiling** | No | No | Yes | No |
| **Dialog handling** | No | Yes | Yes | Yes |
| **Headless / CI** | No | No | No | Yes |

**In short**: Chrome Bridge is the only option that works on ChromeOS, has 31 specialized web development tools, and runs entirely self-hosted with no paid plan required. The tradeoff is no GIF recording, no CDP-level debugging, and no dialog handling.

## Architecture

```
Claude Code <--stdio--> MCP Server <--WebSocket:8765--> Chrome Extension
```

- **MCP Server** (`server/`): Node.js, communicates with Claude Code via stdio and with the extension via WebSocket
- **Chrome Extension** (`extension/`): Manifest V3, executes commands using Chrome APIs and returns results
- All page scripts run via `chrome.scripting.executeScript` (MAIN world). No `chrome.debugger` (broken on ChromeOS).

## Tools (31)

### Core (8)
| Tool | Description |
|------|-------------|
| `get_status` | Check if the Chrome extension is connected |
| `get_tabs` | List all open Chrome tabs |
| `navigate` | Navigate a tab to a URL |
| `screenshot` | Capture visible tab as PNG |
| `execute_js` | Execute JavaScript in page context (ISOLATED world, MAIN fallback) |
| `click` | Click an element by CSS selector |
| `type_text` | Type text into an input element |
| `read_page` | Read page content (text, HTML, or accessibility tree) |

### DevTools (9)
| Tool | Description |
|------|-------------|
| `get_page_info` | Get meta tags, scripts, stylesheets, links, forms |
| `get_storage` | Read localStorage, sessionStorage, cookies |
| `get_performance` | Navigation timing, paint metrics, memory, resources |
| `query_dom` | Query elements with attributes, rect, computed styles |
| `modify_dom` | Set/remove attributes, classes, styles, text content |
| `inject_css` | Inject CSS rules into a tab |
| `read_console` | Capture console messages (log/warn/error/info/debug) |
| `monitor_network` | Monitor XHR and fetch requests |
| `create_tab` | Create a new tab, optionally with a URL |

### Navigation & Forms (4)
| Tool | Description |
|------|-------------|
| `wait_for_element` | Poll until a selector appears (with visibility check) |
| `scroll_to` | Scroll to element or coordinates, with offset for fixed headers |
| `fill_form` | Batch fill form fields with React-compatible events |
| `set_storage` | Write/delete/clear localStorage, sessionStorage, cookies |

### Visual & Responsive (3)
| Tool | Description |
|------|-------------|
| `viewport_resize` | Resize window to preset (mobile/tablet/desktop) or custom size |
| `full_page_screenshot` | Scroll-and-capture full page as multiple PNGs |
| `highlight_elements` | Add colored overlay on matching elements |

### Analysis (3)
| Tool | Description |
|------|-------------|
| `accessibility_audit` | Audit for missing alt, empty links, heading hierarchy, ARIA, contrast, form labels |
| `check_links` | Find broken links (HEAD/GET with timeout, scope filtering) |
| `measure_spacing` | Measure pixel distance, gap, overlap between two elements |

### Interaction (2)
| Tool | Description |
|------|-------------|
| `hover` | Hover over an element (mouseenter/mouseover/mousemove) |
| `press_key` | Press a keyboard key with modifiers (Ctrl/Shift/Alt/Meta) |

### Environment (2)
| Tool | Description |
|------|-------------|
| `watch_dom` | MutationObserver for attribute/childList/characterData changes |
| `emulate_media` | Override prefers-color-scheme, reduced-motion, print mode |

## Install

```bash
git clone git@github.com:frsorrentino/chrome-bridge.git
cd chrome-bridge
./install.sh
```

Or manually:

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

Once installed, the tools are available in Claude Code automatically. The extension connects to the MCP server via WebSocket on port 8765.

Check connection status via the extension popup icon or by calling the `get_status` tool.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHROME_BRIDGE_PORT` | `8765` | WebSocket server port |

## Tests

```bash
# Stop any running MCP server on port 8765 first
node test/test-devtools.js
```

Requires the Chrome extension to be loaded and active. The test script starts its own WebSocket server, creates a test tab on `example.com`, and runs all 23 test cases.

## Project Structure

```
chrome-bridge/
  server/
    index.js          # Entry point: MCP server + WebSocket
    protocol.js       # Message types, timeouts, command builder
    tools.js          # MCP tool registrations (Zod schemas)
    ws-manager.js     # WebSocket server manager
  extension/
    manifest.json     # Chrome MV3 manifest
    service-worker.js # Command handlers, Chrome APIs
    popup.html/js/css # Connection status popup
    icons/            # Extension icons
  test/
    test-devtools.js  # End-to-end test suite (23 tests)
```

## Technical Notes

- `execute_js` uses ISOLATED world by default (bypasses page CSP), with MAIN world fallback
- `chrome.debugger` is not used (doesn't work on ChromeOS)
- Stateful tools (`read_console`, `monitor_network`, `watch_dom`) inject monkey-patches on first call and auto-cleanup on tab navigation/close
- `full_page_screenshot` and `check_links` have 120s timeout; `wait_for_element` has 60s

## License

MIT
