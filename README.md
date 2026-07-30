# Chrome Bridge

![License: MIT](https://img.shields.io/badge/license-MIT-green) ![Node 18+](https://img.shields.io/badge/node-%E2%89%A518-brightgreen) ![Chrome 135+](https://img.shields.io/badge/chrome-%E2%89%A5135-blue) ![Tests](https://img.shields.io/badge/tests-131%20unit%20%2B%20e2e-brightgreen) [![Chrome Web Store](https://img.shields.io/badge/web%20store-published-blue)](https://chromewebstore.google.com/detail/chrome-bridge-for-claude/bioknpaeahidbelaljjohjofiloeodmb)

**Chrome Bridge is an MCP server that connects Claude Code to your real, logged-in Chrome browser — measured 2.75× fewer turns and 2.28× lower cost than the official "Claude in Chrome" extension on a form-filling task, with ~3× the toolset and no paid plan.**

By using a local WebSocket bridge and a specialized Chrome extension, Chrome Bridge provides 60 web-development tools (navigation, DOM inspection, visual regression, audits, network mocking) and a dedicated headless instance for CI. It is self-hosted, local-only, and requires no paid plan.

## Why Chrome Bridge?

Chrome Bridge is designed to be both more efficient and more powerful than Anthropic's official browser extension.

### 1. Efficiency Benchmark
Same model (Claude Sonnet 5), same task, paired runs on the same date and versions, **all runs included** (n=2 per arm — a small sample: direction, not precision):

| Task | Chrome Bridge | Claude in Chrome | Ratio |
| :--- | :--- | :--- | :--- |
| **Form fill** | 6.0 turns (6-6) / $0.211 | 16.5 turns (16-17) / $0.481 | **2.75× turns, 2.28× cost** |
| **1500-row table lookup** | see note | not re-run on this version | *not published* |

On the table-lookup task, an `extract_table` fix took our side from 13.5 to 4.0
turns, but the Claude-in-Chrome arm has not been re-run on that version — so no
ratio is published for it. The inclusion rule, every raw run (including the
unfavourable ones) and the harness limits are in
[bench/RESULTS.md](bench/RESULTS.md).

**Why it wins — it makes fewer round trips, not smaller payloads:**
- **Compact References:** The agent acts on short element handles (e.g., `n1`, `n2`) returned by `navigate` or `get_interactives` instead of the slow screenshot → read-coordinates → click loop.
- **Batching:** `fill_form` fills N fields and submits in one call — measured, 3 calls instead of 9 for the same form, at the same byte count.
- **Server-Side Processing:** Filtering large tables happens server-side (`extract_table` with `where`): 236 bytes to find one row among 1500, against 50,070 bytes for `read_page`. The extension-to-model payload is the token bottleneck; Chrome Bridge moves the heavy lifting to localhost.
- **Honest caveat:** per *turn*, Chrome Bridge costs slightly more than Claude in Chrome (41,985 vs 36,613 cache-read tokens; $0.0373 vs $0.0337). The win is in the number of turns.

### 2. Feature Comparison
Chrome Bridge ships 60 specialized tools (31 core by default) compared to ~20 in Claude in Chrome. It is also the only automation that drives the real host Chrome on ChromeOS/Crostini.

| | Chrome Bridge | Claude in Chrome | Chrome DevTools MCP | Playwright MCP |
|---|---|---|---|---|
| **ChromeOS / Crostini** | **Yes** (real host) | No | Container only | Container only |
| **Tools** | **60** (31 core) | ~20 | ~50 | 23 core (71 total) |
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

> On **ChromeOS/Crostini**, install the published extension from the [Chrome Web Store](https://chromewebstore.google.com/detail/chrome-bridge-for-claude/bioknpaeahidbelaljjohjofiloeodmb) instead of loading it unpacked — a filesystem-loaded extension is dropped on every reboot (the container isn't mounted when Chrome starts).

### Example Session
> *"Open localhost:3000, run an accessibility audit, and find the 'Sign Up' button"*

Claude Code calls `navigate` (returning clickable element refs), `accessibility_audit`, and `find_text`. Because `navigate` returns refs like `n1`, the agent can immediately call `click(ref="n1")` without a discovery turn.

## Token-Efficient Design

- **Opt-in Surface**: 31 core tools cost ≈7.4k tokens of `tools/list`, all 60 cost ≈14.1k; specialized groups (audits, visual, network, storage, dom, files) are opt-in via `--caps`. That core figure was ≈3.8k in 1.8.0 and roughly doubled in 1.10.0: MCP annotations on every tool, rewritten descriptions, and a documented `.describe()` on all 254 parameters (coverage went from 35% to 100%). The trade is deliberate and it is not free — on the form benchmark it adds ≈8% to the cache-read tokens per turn — but the measured advantage was never prefix size, it was round trips: 2.75× fewer turns. Playwright MCP's 23 core tools measured ≈4.6k in July 2026, so on prefix size alone it is the leaner one. Measure ours with `npm run measure`.
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

## Tools (60 total)

### Core & Navigation (7)
`get_status`, `get_tabs`, `create_tab`, `navigate`, `tab_action`, `get_frames`, `screenshot`.

### Interaction (11)
`click`, `type_text`, `fill_form`, `hover`, `press_key`, `scroll`, `drag_and_drop`, `upload_file`, `dismiss_overlays`, `handle_dialogs`, `clipboard`.

### DOM & Inspection (11)
`read_page`, `extract`, `get_page_info`, `query_dom`, `modify_dom`, `find_text`, `get_interactives`, `inject_css`, `highlight_elements`, `watch_dom`, `measure_spacing`.

### Debugging & Network (9)
`execute_js`, `read_console`, `monitor_network`, `monitor_websocket`, `network_rules` (block/redirect/stub/headers), `http_request` (sent with the user's session cookies), `get_performance`, `web_vitals`, `list_event_listeners`.

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

Configure the server via environment variables (or the matching CLI flags):
- `CHROME_BRIDGE_PORT`: Default `8765`.
- `CHROME_BRIDGE_HOST` / `--host`: Bind address, default `127.0.0.1`. Set to `0.0.0.0` **only** where the browser lives outside the container (ChromeOS/Crostini port-forward) — and pair it with a token.
- `CHROME_BRIDGE_TOKEN`: Shared secret required on both `ext_init` and `relay_init`. Strongly recommended whenever the bind is not loopback.
- `CHROME_BRIDGE_CAPS` / `--caps`: Tool groups to load (`core`, `audits`, `visual`, `network`, `storage`, `dom`, `files`, or `all`). `install.sh` registers with `all`; the bare server defaults to `core` (31 tools). `get_status` reports `caps_active` and `caps_available`.

Run `node tools/measure-schema.mjs` to see the exact schema cost of the active set.

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

- **Loopback by default**: the WebSocket server binds `127.0.0.1`. Exposing it to the network is opt-in via `CHROME_BRIDGE_HOST`/`--host`.
- **Origin validation**: extension connections are only accepted from a `chrome-extension://` origin, and — with a loopback bind — only from loopback.
- **Token on both handshakes**: `CHROME_BRIDGE_TOKEN`, when set, is required for `ext_init` *and* `relay_init`. Without it, any local process could act as a relay and reach `execute_js` in your authenticated browser session.
- **Relay security**: secondary MCP instances must connect via loopback and are acknowledged with `relay_init_ok`, so a foreign process holding the port fails fast instead of timing out per command.
- **What is *not* protected**: page content reaches the model unfiltered, so a hostile page's text is untrusted input; `get_storage`, `session_fixture`, HAR exports and screenshots are **not** redacted and may carry cookies, tokens or personal data. Do not point the automation at pages holding secrets you would not paste into a chat.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Chrome extension not connected` | Extension disabled, or its port differs from the server's. The error names the actual host/port; check them in the popup (⚙). |
| Port 8765 already in use | Expected: a second MCP session becomes a **relay** and shares the one bridge. Set `CHROME_BRIDGE_PORT` for a separate one. |
| `Port N is held by a process that is not chrome-bridge` | Something else owns the port. Free it or change `CHROME_BRIDGE_PORT`. |
| `execute_js` fails | Enable **Allow user scripts** in `chrome://extensions` → Chrome Bridge → Details (Chrome 138+; on 135-137 enable Developer Mode). |
| `read_console` returns a `note=Instrumentation not loaded` | The page was opened before the extension, "Capture console & metrics" is off, or the page is not injectable (`chrome://`). Reload the page. |
| Screenshot times out | On ChromeOS a fully occluded window stops producing frames; captures fail after 10s. Bring the window forward. |
| Commands work then stop after a while | The MV3 service worker restarted and in-memory state (network log, diff baselines, HTTP auth) was reset. Re-run the monitoring call. |
| Extension is dropped on every ChromeOS reboot | Install from the Chrome Web Store instead of Load unpacked: the Crostini filesystem isn't mounted when Chrome starts. |
| Tool missing from the list | It's in an opt-in capability group. Check `get_status` → `caps_available`, then set `CHROME_BRIDGE_CAPS=all`. |

## Tests
- **Unit**: `npm test` (Chrome-free, ~22s).
- **E2E**: `npm run test:e2e` (requires Chrome and a connected extension).
- **Schema cost**: `npm run measure`.

## License
MIT
