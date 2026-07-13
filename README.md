# Chrome Bridge

![License: MIT](https://img.shields.io/badge/license-MIT-green) ![Node 18+](https://img.shields.io/badge/node-%E2%89%A518-brightgreen) ![Chrome 135+](https://img.shields.io/badge/chrome-%E2%89%A5135-blue) ![Tests](https://img.shields.io/badge/tests-95%20unit%20%2B%2025%20e2e-brightgreen) ![Chrome Web Store](https://img.shields.io/badge/web%20store-published-blue)

**Chrome Bridge is an MCP server that connects Claude Code to your real, logged-in Chrome browser — 2.3–2.8× more token-efficient and ~3× the toolset of the official "Claude in Chrome" extension, with no paid plan.**

By using a local WebSocket bridge and a specialized Chrome extension, Chrome Bridge provides 59 web-development tools (navigation, DOM inspection, visual regression, audits, network mocking) and a dedicated headless instance for CI. It is self-hosted, local-only, and requires no paid plan.

## Why Chrome Bridge?

Chrome Bridge is designed to be both more efficient and more powerful than Anthropic's official browser extension.

### 1. Directional Efficiency Benchmark
In a same-model, two-task benchmark (Claude Sonnet 5, headless, July 2026, n=2 per cell), Chrome Bridge used **2.3–2.8× fewer turns, tokens, and dollars** than Claude in Chrome.

| Task | Chrome Bridge | Claude in Chrome | Savings |
| :--- | :--- | :--- | :--- |
| **Form fill task** | 6.0 turns / $0.21 | 16.5 turns / $0.48 | **~2.3x** |
| **1500-row table lookup** | 4.0 turns / $0.18 | 11.0 turns / $0.41 | **~2.3x** |

**Why it wins:**
- **Compact References:** The agent acts on short element handles (e.g., `n1`, `n2`) returned by `navigate` or `get_interactives` instead of the slow screenshot → read-coordinates → click loop.
- **Server-Side Processing:** Filtering and paginating large tables happens server-side (`extract_table` with `where`). The extension-to-model payload is the token bottleneck; Chrome Bridge moves the heavy lifting to localhost.
- *Full method and data available in [bench/RESULTS.md](bench/RESULTS.md).*

### 2. Feature Comparison
Chrome Bridge ships 59 specialized tools (30 core by default) compared to ~20 in Claude in Chrome. It is also the only automation that drives the real host Chrome on ChromeOS/Crostini.

| | Chrome Bridge | Claude in Chrome | Chrome DevTools MCP | Playwright MCP |
|---|---|---|---|---|
| **ChromeOS / Crostini** | **Yes** (real host) | No | Container only | Container only |
| **Tools** | **59** (30 core) | ~20 | ~50 | 23 core (71 total) |
| **Requires Paid Plan** | **No** | Yes (Pro+) | No | No |
| **Network Mocking** | **Yes** (stub/headers) | No | No | Yes |
| **Visual Regression** | **Yes** (`screenshot_diff`) | No | No | No |
| **Audits (A11y/SEO/Sec)** | **Yes** (Full suite) | No | Partial | No |
| **Headless / CI** | **Yes** | No | Yes | Yes |
| **GIF / Video** | No | **Yes** | Partial | No |
| **Breakpoints / Heap** | No | No | **Yes** | No |

## Quickstart

```bash
git clone git@github.com:frsorrentino/chrome-bridge.git && cd chrome-bridge && ./install.sh
```

1. Load the extension: Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `extension/` folder.
2. Restart Claude Code.

> On **ChromeOS/Crostini**, install the published extension from the Chrome Web Store instead of loading it unpacked — a filesystem-loaded extension is dropped on every reboot (the container isn't mounted when Chrome starts). See the [project homepage](https://frsorrentino.github.io/chrome-bridge/) for the store link.

### Example Session
> *"Open localhost:3000, run an accessibility audit, and find the 'Sign Up' button"*

Claude Code calls `navigate` (returning clickable element refs), `accessibility_audit`, and `find_text`. Because `navigate` returns refs like `n1`, the agent can immediately call `click(ref="n1")` without a discovery turn.

## Token-Efficient Design

- **Compact Schemas**: 30 core tools use ≈3.9k tokens of schemas (vs Playwright MCP's ~4.6k). Specialized groups (audits, visual, network, storage, dom, files) are opt-in via `--caps`.
- **Act-from-Result**: Tools attach a capped preview of interactive elements with short refs. Actions only report a `page_changed` delta when the URL or title actually changes.
- **Optimized Media**: Screenshots are downscaled to ≤1568px. Full-page captures are sliced into readable segments.
- **Zero-Token Escape Hatches**: The [CLI](#cli) skips MCP schemas entirely, and recorded flows [replay](#launch-mode-headless--ci) without any model in the loop.

## Highlights

- **Launch Mode**: Start a dedicated Chromium instance with an ephemeral profile for isolated sessions or CI.
- **Network Mocking**: Block/redirect requests, rewrite headers, or stub response bodies with synthetic data.
- **Visual Regression**: Use `screenshot_diff` to compare current pages against named baselines.
- **Structured Extraction**: One-call `extract` for repeated data and `extract_table` with server-side `where` filtering.

## Architecture

```
Claude Code  <--stdio-->  MCP Server  <--WebSocket :8765-->  Chrome Extension
                          (server/)                          (extension/, MV3)
```

The **MCP Server** (Node.js) handles the protocol and tool logic. The **Chrome Extension** (MV3) executes commands via Chrome APIs. User scripts (`execute_js`) run via `chrome.userScripts.execute()`, requiring the "Allow user scripts" toggle in extension settings.

## Tools (59 total)

### Core & Navigation (7)
`get_status`, `get_tabs`, `create_tab`, `navigate`, `tab_action`, `get_frames`, `screenshot`.

### Interaction (11)
`click`, `type_text`, `fill_form`, `hover`, `press_key`, `scroll`, `drag_and_drop`, `upload_file`, `dismiss_overlays`, `handle_dialogs`, `clipboard`.

### DOM & Inspection (11)
`read_page`, `extract`, `get_page_info`, `query_dom`, `modify_dom`, `find_text`, `get_interactives`, `inject_css`, `highlight_elements`, `watch_dom`, `measure_spacing`.

### Debugging & Network (8)
`execute_js`, `read_console`, `monitor_network`, `monitor_websocket`, `network_rules` (block/redirect/stub/headers), `get_performance`, `web_vitals`, `list_event_listeners`.

### Visual & Responsive (7)
`element_screenshot`, `full_page_screenshot`, `screenshot_diff`, `viewport_resize`, `set_zoom`, `emulate_media`, `set_geolocation`.

### Audits (6)
`accessibility_audit`, `seo_audit`, `security_headers`, `check_links` (server-side verification), `unused_css`, `extract_table` (with `where` filtering).

### State, Storage & Files (9)
`get_storage`, `set_storage`, `session_fixture`, `http_auth`, `save_page` (MHTML), `manage_downloads`, `session_record`, `wait_for`, `assert`.

## Install

**Requirements:** Node.js 18+, Chrome 135+.

### From Source
```bash
git clone git@github.com:frsorrentino/chrome-bridge.git
cd chrome-bridge
./install.sh
```
`install.sh` registers the MCP server in Claude Code (`--scope user`).

### Manual Registration
```bash
claude mcp add --scope user chrome-bridge node /path/to/server/index.js
```

**Note:** For `execute_js`, you must enable **"Allow user scripts"** in `chrome://extensions` → Chrome Bridge → Details. On Chrome 135-137, enable Developer Mode instead.

## Configuration

Configure the server via environment variables:
- `CHROME_BRIDGE_PORT`: Default `8765`.
- `CHROME_BRIDGE_TOKEN`: Optional shared secret for WebSocket security.
- `CHROME_BRIDGE_CAPS`: Tool groups to load (`core`, `audits`, `visual`, `network`, `storage`, `dom`, `files`, or `all`).

## CLI

The CLI allows batch operations and pipes output through `grep` or `jq` before it reaches the model:
```bash
chrome-bridge navigate --url https://example.com
chrome-bridge read_console --level error | head -20
chrome-bridge assert --selector "#success" --text "Done"
chrome-bridge replay --file ./recordings/login.jsonl
```

## Launch Mode (Headless / CI)

Launch mode starts a dedicated Chromium instance with an ephemeral profile:
```bash
node server/index.js --launch --headless
```
Perfect for CI smoke tests using `session_record` + `replay`. Note: `execute_js` uses a `new Function` fallback in launch mode if the user-script toggle is unavailable.

## Security

- **Origin Validation**: Extension connections are only accepted from the `chrome-extension://` origin.
- **Relay Security**: Secondary MCP instances (relays) must connect via loopback.
- **Shared Token**: Use `CHROME_BRIDGE_TOKEN` to gate access on untrusted networks (especially on Crostini where the server binds `0.0.0.0`).

## Tests
- **Unit**: `npm run test:unit` (95 tests).
- **E2E**: `node test/test-devtools.js` (25 tests, requires Chrome).

## License
MIT
