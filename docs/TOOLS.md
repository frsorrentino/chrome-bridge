# Tool reference

All 60 tools, by capability group. The group name is the value to pass to
`--caps` / `CHROME_BRIDGE_CAPS`. Only `core` loads by default (39 tools);
`install.sh` registers the server with `all`.

Check what is active in your session with `get_status` → `caps_active` /
`caps_available`, and the schema cost of that set with `npm run measure`.

## Core & Navigation (13) — group `core`

`get_status`, `get_tabs`, `create_tab`, `navigate`, `tab_action`,
`move_tab` (between windows), `tile_windows` (split one monitor evenly),
`window_layout` (save/restore arrangements by name),
`get_frames`, `screenshot`.
`find_setting` follows the menu links of an unknown admin panel until a page
contains the keyword and reports the menu path. `handoff` shows a banner in the
page and waits for the user (2FA, CAPTCHA, a choice); with `pick_element` the
user clicks an element and the tool returns its selector; with `ask` the user
types a reply (`answer`), with `pick_max` up to N elements (`picked_all`).
`click` and `fill_form` return `page_changed`, the DOM delta before and after
the action; `type_text` and each `fill_form` field return `value_after` and
`mismatch`. `watch` keeps checking
a page in the background (element/text appears or disappears, a value changes)
and collects events for `poll` or `chrome-bridge watch --wait`. `read_form` reads a form as
the user filled it (values, required-but-empty, validity; passwords redacted) to review it
before an irreversible submit. `session_record observe` transcribes what the user does in a
tab into a replayable flow and a readable procedure, never recording sensitive values;
`chrome-bridge evidence --url` captures a page as this user sees it, hashed and redacted.

`navigate` returns clickable element refs (`n1`, `n2`, …) with the page, so the
agent can act without a separate discovery call.

## Interaction (11) — group `core`

`click`, `type_text`, `fill_form`, `hover`, `press_key`, `scroll`,
`drag_and_drop`, `upload_file`, `dismiss_overlays`, `handle_dialogs`,
`clipboard`.

`fill_form` fills N fields and submits in one call — 3 calls instead of 9 on the
benchmark form, at the same byte count.

## DOM & Inspection (11) — group `dom`

`read_page`, `extract`, `get_page_info`, `query_dom`, `get_css_styles`, `modify_dom`, `find_text`,
`get_interactives`, `inject_css`, `watch_dom`, `get_page_info` (with `dev`: dev server and
error overlay when one is open),
`measure_spacing`.

`get_css_styles` is the Styles panel of DevTools as text: for each property the
winning declaration (selector, stylesheet, rule position, `!important`, `@layer`,
`@media`) and the ones it overrides; `include_inherited` walks the ancestors for
`color`, `font-*` and custom properties. Built from the CSSOM, so a stylesheet
from another origin without CORS is opaque (listed by href) and `@container` /
`@scope` rules are not evaluated (`skipped`).

`read_page(mode="markdown")` keeps headings, links and tables at a fraction of
the HTML cost. `read_page`, `extract`, `screenshot` and `http_request` accept
`save_to`: the result goes to a file and the tool returns the path, so the bytes
never enter the context unless the agent decides to read them. Since Claude
Code 2.1.283 every image a tool returns (`screenshot`, `element_screenshot`,
`full_page_screenshot` without `save_to`) is also written to a file by the
client, and the result names the path: reuse it with Read or Bash instead of
capturing again. `save_to` still decides where the file goes.

## Debugging & Network (8) — group `network`

`execute_js`, `read_console`, `monitor_network` (page, browser or websocket source),
`network_rules` (block, redirect, headers, stub, and record/replay of real API responses with forced errors) (block / redirect / stub / headers),
`http_request` (sent with the user's session cookies),
`track_events` (GA4/Meta/Ads/TikTok beacons decoded from the browser log).

`execute_js` needs **Allow user scripts** enabled in the extension details.

## Visual & Responsive (5) — group `visual`

`element_screenshot`, `full_page_screenshot`, `screenshot_diff`,
`viewport_resize` (presets, explicit size, zoom), `emulate_media`, `set_geolocation`.

`screenshot_diff` also takes its baseline from a PNG on disk (`from_file`): the
design mockup or a production screenshot becomes the reference; `compare_urls`
diffs two pages (production vs staging) in pixels and in text. `screenshot`
takes `presets` for one capture per viewport in a single call.
Screenshots are downscaled to ≤1568px; to read fine print, `element_screenshot`
crops a box (by `selector`, or by `region` in viewport CSS px) and enlarges it
with `scale` (1-4). Full-page captures are sliced into readable segments. `screenshot_diff` compares the current page against a named
baseline.

## Audits (2) — group `audits`

`audit` (accessibility, keyboard = tab order and focus issues, SEO, security headers, broken links verified server-side,
Core Web Vitals, unused CSS, `resources` = which plugin/theme/module/host slows
the page, `cache` = is the CDN serving the new version — pick the kinds,
`save_to` writes the Markdown report), `cookie_audit` (what fires before
consent).
The six former single audits stay available as CLI commands.

`extract_table` filters server-side: 236 bytes to find one row among 1500,
against 50,070 bytes for `read_page` on the same table.

## State, Storage & Files (9) — groups `storage`, `files`

`get_storage`, `set_storage`, `session_fixture`, `http_auth`,
`save_page` (MHTML), `manage_downloads`, `session_record`, `wait_for`, `assert`.

`session_record` + `replay` run a recorded flow with no model in the loop —
the basis for CI smoke tests.

## Stateful tools

`read_console`, `monitor_network` and `watch_dom` keep
state in the extension's service worker. That worker restarts on its own: when
it does, the network log, diff baselines and HTTP auth are reset and the
monitoring call has to be re-issued.
