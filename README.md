# Chrome Bridge

![License: MIT](https://img.shields.io/badge/license-MIT-green) ![Node 18+](https://img.shields.io/badge/node-%E2%89%A518-brightgreen) ![Chrome 135+](https://img.shields.io/badge/chrome-%E2%89%A5135-blue) ![Tests](https://img.shields.io/badge/tests-174%20unit%20%2B%20e2e-brightgreen) [![Chrome Web Store](https://img.shields.io/badge/web%20store-published-blue)](https://chromewebstore.google.com/detail/chrome-bridge-for-claude/bioknpaeahidbelaljjohjofiloeodmb)

**An MCP server that gives Claude Code your real, logged-in Chrome — measured
2.75× fewer turns and 2.28× lower cost than the official "Claude in Chrome"
extension on a form-filling task, with ~3× the toolset and no paid plan.**

62 web-development tools (navigation, DOM inspection, visual regression, audits,
network mocking) over a local WebSocket bridge, plus a headless instance for CI.
Self-hosted, local-only.

## Quickstart

**Requires** Node.js 18+ and Chrome 135+.

```bash
git clone git@github.com:frsorrentino/chrome-bridge.git
cd chrome-bridge && ./install.sh
```

1. Open `chrome://extensions`, enable **Developer mode**, click **Load
   unpacked**, select the `extension/` folder.
2. Restart Claude Code.

Then ask for something like *"open localhost:3000, run an accessibility audit
and find the Sign Up button"*: Claude Code calls `navigate`,
`accessibility_audit` and `find_text`. Because `navigate` already returns
element refs, `click(ref="n1")` follows with no discovery turn in between.

> **On ChromeOS/Crostini** install from the [Chrome Web
> Store](https://chromewebstore.google.com/detail/chrome-bridge-for-claude/bioknpaeahidbelaljjohjofiloeodmb)
> instead: an unpacked extension is dropped on every reboot, because the
> container isn't mounted when Chrome starts.

`install.sh` registers the MCP server with `--scope user`. To do it by hand:
`claude mcp add --scope user chrome-bridge node /path/to/server/index.js`.
For `execute_js`, enable **Allow user scripts** in `chrome://extensions` →
Chrome Bridge → Details (on Chrome 135-137, enable Developer Mode instead).

## Why Chrome Bridge?

| | Chrome Bridge | Claude in Chrome | Chrome DevTools MCP | Playwright MCP |
|---|---|---|---|---|
| **ChromeOS / Crostini** | **Yes** (real host) | No | Container only | Container only |
| **Tools** | **62** (33 core) | ~20 | ~50 | 23 core (71 total) |
| **Requires paid plan** | **No** | Yes (Pro+) | No | No |
| **Network mocking** | **Yes** (stub/headers) | No | No | Yes |
| **Visual regression** | **Yes** (`screenshot_diff`) | No | No | No |
| **Audits (a11y/SEO/sec)** | **Yes** (full suite) | No | Partial | No |
| **Headless / CI** | **Yes** | No | Yes | Yes |
| **GIF / video** | No | **Yes** | Partial | No |
| **Breakpoints / heap** | No | No | **Yes** | No |

It wins on **round trips, not payload size**: short element refs instead of the
screenshot-and-click loop, `fill_form` filling N fields in one call, table
filtering done server-side. Per single turn it actually costs slightly *more*.

The full benchmark — method, every raw run including the unfavourable ones, and
what the harness can't measure — is in
[docs/EFFICIENCY.md](docs/EFFICIENCY.md).

## Using it

Beyond the MCP tools, two lanes keep work away from the model entirely.

**CLI** — batch operations, piped through `grep` or `jq` before anything reaches
the context:

```bash
chrome-bridge navigate --url https://example.com
chrome-bridge read_console --level error | head -20
chrome-bridge assert --selector "#success" --text "Done"
chrome-bridge replay --file ./recordings/login.jsonl
```

**Launch mode** — a dedicated Chromium instance with an ephemeral profile, for
isolated sessions or CI:

```bash
node server/index.js --launch --headless
```

Pair it with `session_record` + `replay` for smoke tests with no model in the
loop. In launch mode `execute_js` falls back to `new Function` when the
user-script toggle isn't available.

## Tools

62 in total, in seven groups. Only `core` (33 tools) loads by default; the rest
are opt-in via `--caps`.

| Group | N | What's in it |
|---|---|---|
| Core & Navigation | 9 | tabs, windows, `navigate`, `screenshot`, `tile_windows` |
| Interaction | 11 | `click`, `fill_form`, `upload_file`, dialogs, clipboard |
| DOM & Inspection | 11 | `read_page`, `extract`, `query_dom`, `watch_dom` |
| Debugging & Network | 9 | `execute_js`, console, network log, mocking, Web Vitals |
| Visual & Responsive | 7 | `screenshot_diff`, viewport, zoom, media emulation |
| Audits | 6 | a11y, SEO, security headers, links, `extract_table` |
| State, Storage & Files | 9 | storage, fixtures, MHTML, recording, `assert` |

Every tool, with the notes that matter: [docs/TOOLS.md](docs/TOOLS.md).

## How it works

```
Claude Code  <--stdio-->  MCP Server  <--WebSocket :8765-->  Chrome Extension
                          (server/)                          (extension/, MV3)
```

The Node.js server handles the protocol and tool logic; the MV3 extension
executes commands through Chrome APIs. User scripts (`execute_js`) run via
`chrome.userScripts.execute()`.

## Configuration and security

Environment variables, each with a matching CLI flag:

| Variable | Default | Notes |
|---|---|---|
| `CHROME_BRIDGE_PORT` | `8765` | |
| `CHROME_BRIDGE_HOST` / `--host` | `127.0.0.1` | `0.0.0.0` **only** where the browser lives outside the container (ChromeOS/Crostini port-forward) — and only with a token |
| `CHROME_BRIDGE_TOKEN` | unset | Required on both `ext_init` and `relay_init`. Strongly recommended whenever the bind isn't loopback |
| `CHROME_BRIDGE_CAPS` / `--caps` | `core` | `core`, `audits`, `visual`, `network`, `storage`, `dom`, `files`, `all`. `install.sh` uses `all` |

The bridge binds loopback, accepts extension connections only from a
`chrome-extension://` origin, and — when a token is set — requires it on both
handshakes. Without one, any local process could act as a relay and reach
`execute_js` inside your authenticated browser session. Secondary MCP instances
connect via loopback and are acknowledged with `relay_init_ok`, so a foreign
process holding the port fails fast instead of timing out per command.

**What is *not* protected:** page content reaches the model unfiltered, so a
hostile page's text is untrusted input. `get_storage`, `session_fixture`, HAR
exports and screenshots are **not** redacted and may carry cookies, tokens or
personal data. Don't point the automation at pages holding secrets you wouldn't
paste into a chat.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Chrome extension not connected` | Extension disabled, or its port differs from the server's. The error names the actual host/port; check them in the popup (⚙). |
| Port 8765 already in use | Expected: a second MCP session becomes a **relay** and shares the one bridge. Set `CHROME_BRIDGE_PORT` for a separate one. |
| `Port N is held by a process that is not chrome-bridge` | Something else owns the port. Free it or change `CHROME_BRIDGE_PORT`. |
| `execute_js` fails | Enable **Allow user scripts** in `chrome://extensions` → Chrome Bridge → Details (Chrome 138+; on 135-137 enable Developer Mode). |
| `read_console` returns `note=Instrumentation not loaded` | The page was opened before the extension, "Capture console & metrics" is off, or the page isn't injectable (`chrome://`). Reload it. |
| Screenshot times out | On ChromeOS a fully occluded window stops producing frames; captures fail after 10s. Bring the window forward. |
| Commands work, then stop | The MV3 service worker restarted and in-memory state (network log, diff baselines, HTTP auth) was reset. Re-run the monitoring call. |
| Extension dropped on every ChromeOS reboot | Install from the Web Store instead of Load unpacked. |
| Tool missing from the list | It's in an opt-in group. Check `get_status` → `caps_available`, then set `CHROME_BRIDGE_CAPS=all`. |

## Documentation

- [docs/TOOLS.md](docs/TOOLS.md) — all 62 tools, by group
- [docs/EFFICIENCY.md](docs/EFFICIENCY.md) — the benchmark and the design behind it
- [bench/RESULTS.md](bench/RESULTS.md) — raw runs and inclusion rule
- [CHANGELOG.md](CHANGELOG.md)

## Tests

`npm test` (Chrome-free, ~22s) · `npm run test:e2e` (needs Chrome and a
connected extension) · `npm run measure` (schema cost).

## License

MIT
