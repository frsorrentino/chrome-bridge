# What Chrome Bridge gets past, and what it does not

One row per wall that stops browser automation, with a state and a date.
A list that only says yes is a brochure; this one is for planning against.

| State | Means |
|---|---|
| **Measured** | Exercised by a dated run: the e2e suite in headless launch mode (`npm run test:e2e:launch`, 36/36 on 2026-09-11), the latency bench (`docs/PERFORMANCE.md`, 2026-09-11), or a live session on the author's machine. |
| **By design** | The code path exists and is unit-tested on the server side, but no dated end-to-end measurement. Likely, not proven. |
| **Not yet** | Tried or wanted, does not work today. The reason is given. |
| **Won't** | A deliberate non-goal, with the reason. |

## Walls that exist because the tool is not you

| Wall | State | Note |
|---|---|---|
| Site requires a login | **Measured** (daily use) | It is the Chrome you are already signed into: there is no login step to fail. |
| 2FA, CAPTCHA, a consent screen, "which of these?" | **Measured** 2026-09-11 | `handoff` shows a banner in the page and waits for the person: Done/Cancel, `ask` for a typed reply, `pick_element`/`pick_max` for elements. Human Done and picker clicked live on 2026-09-02; typed reply and multi-pick driven through the bridge in the e2e. |
| One-time code in your webmail | **By design** | Navigate to the webmail tab you are logged into, `find_text` the code, type it back. No recipe in the skill yet. |
| Session expires mid-task | **By design** | Same session as your own tab; it expires when yours does. |
| SSO / corporate identity provider | **By design** | Already signed in, same as any other session. |

## Walls in the page itself

| Wall | State | Note |
|---|---|---|
| Strict CSP blocks injected script | **By design** | `execute_js` runs through the `userScripts` API when "Allow user scripts" is on (Chrome 138+), which CSP does not govern; with the toggle off it falls back to the MAIN world and CSP can block it, and the error says which toggle to flip. |
| Content in an iframe | **By design** | `get_frames`, then `frame_id` on any DOM tool. |
| Shadow DOM | **Measured** 2026-09-11 | Selectors pierce with `>>>`; the e2e types into a shadow-root input and clicks a shadow-root button that way. |
| React/Vue controlled input that "resets itself" | **Measured** 2026-09-11 on a plain input; **By design** on frameworks | `type_text` and `fill_form` write through the native value setter and fire `input`/`change`, then read the field back: `value_after` and `mismatch` tell you when the page threw the value away. Not yet measured against a real React form. |
| Did the click do anything? | **Measured** 2026-09-11 | `click` and `fill_form` return `page_changed`: url, title and DOM deltas (nodes, text, open, expanded, checked, selected, dialogs, focus) from a fingerprint before and after. The e2e opens a `<details>` and sees `open +1`. |
| Native `<select>` | **Measured** 2026-09-11 | `fill_form` matches an option by value or text; the e2e selects one. |
| "Why is this margin 0?" — which rule wins | **Measured** 2026-09-24 | `get_css_styles`: per property the winning declaration (selector, stylesheet, rule position, `!important`, `@layer`, `@media`) and the overridden ones; `include_inherited` walks the ancestors. From the CSSOM, no debugger: a stylesheet from another origin without CORS is opaque (listed by href), `@container` / `@scope` are not evaluated (`skipped`). The e2e reads example.com's `body{width:60vw}` and `h1` inheriting `font-family` from `body`. |
| Custom combobox / dropdown (div + listbox) | **Not yet** as one tool | No combobox tool: `click` the trigger, read `page_changed.expanded`, `click` the option. Works when the menu renders in the DOM; a dropdown that needs real pointer events (`isTrusted`) does not open from synthetic ones, and no `debugger` means no trusted events. |
| Date picker | **By design** | `type_text` with an ISO value on `input[type=date]`; custom pickers as above. |
| File upload, drag-and-drop targets | **By design** | `upload_file` (from the server's filesystem), `drag_and_drop`. |
| Cookie banner or modal in the way | **By design** | `dismiss_overlays`; `click` reports `occluded` with the occluder's selector instead of clicking through. |
| `alert` / `confirm` freezing the page | **By design** | `handle_dialogs` first; a native `confirm()` opened by a click blocks the bridge until handled, and the `click` description says so. |
| Content that only loads on scroll | **By design** | `scroll action=until` (element, network idle, no new content). |
| Page needs the network to settle | **Measured** 2026-09-11 | `wait_for` element/text/function/navigation/network_idle, all in the e2e. |
| Console, network, web vitals | **Measured** 2026-09-11 | `read_console`, `monitor_network` (page hook, browser-level, WebSocket, HAR), `audit vitals`. |
| Screenshots, visual regression | **Measured** 2026-09-11 | `screenshot`, `element_screenshot` (region, scale), `full_page_screenshot`, `screenshot_diff` with a baseline from disk. Known: two captures closer than ~500 ms hit Chrome's 2-per-second quota (`docs/PERFORMANCE.md`). |
| Accessibility, SEO, security headers, links, unused CSS, cache | **Measured** 2026-09-11 (a11y) / **By design** (rest) | `audit` runs the nine kinds in one call and writes the report to disk; the e2e runs the accessibility audit, the others are unit-tested on fixtures. |

## Environment

| Wall | State | Note |
|---|---|---|
| ChromeOS / Crostini | **Measured** (author's daily machine, last 2026-09-02) | The extension runs in the host Chrome, the server in the container, port-forwarded with a token. Multi-monitor window tiling verified live in 1.13–1.15. Install the extension from the Web Store: an unpacked one is dropped at every reboot. |
| Linux desktop | **Measured** 2026-09-11 | This e2e and the latency bench run on Linux, headless launch mode. |
| macOS, Windows | **By design** | Node + Chrome, nothing platform-specific in the server; no dated run. |
| Headless / CI | **Measured** 2026-09-11 | `--launch --headless` opens a dedicated Chromium with the unpacked extension; the e2e and the bench use it. |
| A second MCP session on the same browser | **Measured** (daily use) | The second server becomes a relay through the first; the two still share tabs and refs, so two agents on the same tab step on each other. |
| ChromeOS Terminal: a window of session tabs without the «Terminale» home tab | **Measured** 2026-09-11 (live, 8 sessions) | The home tab cannot be closed while other tabs exist and cannot be moved between app windows, but it can be pulled out: `move_tab {tab_id: home, new_window: true, window_type: popup}` leaves the app window with the sessions only, then `tab_action close` on the home (alone in its popup) closes it. `tab_action duplicate` on a session tab adds tabs to the home-less app window. No new code: three existing tools. |
| Two Chrome profiles | **Not yet** | One extension connection per server. Not scheduled. |
| No arbitrary JavaScript, confined file writes | **Measured** 2026-09-11 (unit) | `CHROME_BRIDGE_NO_JS`, `CHROME_BRIDGE_WRITE_ROOT`; both visible in `get_status`. |
| Latency | **Measured** 2026-09-11 | `docs/PERFORMANCE.md`: DOM tools under 50 ms, `navigate` 158 ms, `extract_table` on 1 500 rows 108 ms, cold start 11 s in launch mode. |

## Walls we will not cross

| Wall | Why not |
|---|---|
| Bot detection (Cloudflare, DataDome, fingerprinting) | Chrome Bridge works because it **is** your browser, not because anything is circumvented. |
| Breakpoints, heap snapshots, performance traces, `captureBeyondViewport` | They need the `debugger` permission and its yellow "is debugging this browser" bar. The extension asks for 14 permissions and not that one, by choice; `full_page_screenshot` stitches segments within the capture quota instead. |
| `chrome://` pages, the Web Store, `data:` URLs | Chrome forbids scripting them; the tools say so instead of failing vaguely. |
| Accounts that are not yours | The session is the one in your Chrome. That boundary is not a technical one. |

## Open, reproducible, no fix decided

`tab_action close` on a `#home` tab of the ChromeOS Terminal times out after 30 s and the tab stays open (see `CHANGELOG.md`, Unreleased). The bridge is healthy while it happens; the cause has not been observed.

If you hit a wall that is not here, open an issue with the page and the tool call: every **Not yet** row above started that way.
