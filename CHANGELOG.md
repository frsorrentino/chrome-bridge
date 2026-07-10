# Changelog

## 1.6.0 (unreleased — server available from source; extension update pending Chrome Web Store review)

- **Launch mode — headless & CI**: `node server/index.js --launch [--headless]` starts a dedicated Chromium with an ephemeral profile and the extension loaded unpacked, on an ephemeral WS port (no conflict with your everyday bridge). Isolated, reproducible sessions; combine with `replay` + `assert` for zero-token CI smoke tests. In launch mode `execute_js`/`wait_for(function)` run through a `new Function` fallback (no userScripts toggle in a fresh profile) — pages with a strict CSP need a `network_rules` header strip first. The Web Store package is unaffected: the fallback only activates in launch-mode copies.
- **Capability groups**: the MCP server registers the 30 core tools by default. Enable more with `--caps audits,visual,network,storage,dom,files` (or `CHROME_BRIDGE_CAPS`); `--caps all` restores the full 59.
- **Refs**: `get_interactives`, `navigate` and `find_text` return short refs (`n1`, `n2`…) that `click`/`type_text`/`hover` accept in place of a CSS selector.
- **Act-from-result**: `navigate` attaches a capped preview of the page's interactive elements; `find_text` attaches the ones nearest the first match. `click`/`fill_form` report a `page_changed` {url, title} delta when something changed.
- **Session tab default**: commands without `tab_id` target the tab last navigated/created by the session instead of the user-visible active tab — automation no longer collides with what you're doing in Chrome meanwhile.
- **`extract`**: pull repeated structured data (rows, cards, lists) in one call — item selector plus per-field relative selectors, parsed server-side. Deterministic, no LLM round-trips per item.
- **Record & replay**: `session_record` captures the session's commands as jsonl; `chrome-bridge replay --file flow.jsonl --vars '{"user":"jane"}'` re-runs the flow in a single process with `{{var}}` substitution — repeat runs cost zero model tokens.
- **`assert`**: polling assertions (element/text/count/url/title, substring or `/regex/`). Recorded flows replay as smoke tests: a failed assert marks the step ERR and sets exit code 1.
- **Response stubbing**: `network_rules action=stub` serves synthetic bodies (status, content-type) for matching requests via a local helper server — API mocking beyond block/redirect/headers. MCP-session only.
- Fixes: a11y audit now flags images with a *missing* `alt` as errors (was mis-detected as decorative); baseline cap race in `screenshot_diff`; diagnostic warning when the extension drops a message on a closed WebSocket.

## 1.5.0

- **Chrome Web Store ready** — zero `eval`: `execute_js` and `wait_for` (`condition=function`) run user code through the official `chrome.userScripts.execute()` API. One-time setup: enable **"Allow user scripts"** in `chrome://extensions` → Chrome Bridge → Details (Chrome 138+; on 135-137 enable Developer Mode). The popup warns when the toggle is off; every other tool works regardless.
- **Background captures — no more focus stealing**: `screenshot`, `full_page_screenshot`, `element_screenshot` and `screenshot_diff` activate the target tab *without* bringing the Chrome window to the foreground, then restore the previously active tab (and minimized state).
- **No more hanging captures**: on ChromeOS a fully occluded window can stop producing frames; captures now fail after 10s with a clear message instead of hanging forever.
- **`execute_js` runs in the MAIN world** by default (page variables and injected `<script>` tags behave as expected), with `USER_SCRIPT` world fallback. Page CSP no longer blocks it — code is injected, not `eval`'d.
- Requires **Chrome 135+** (was 111+).
