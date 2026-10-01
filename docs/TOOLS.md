# Tool reference

All 66 tools, by area. `core` (43 tools, every tool used in 101 real
sessions) loads by default. The other 23 sit in seven optional caps, which the
agent switches on mid-session with `get_status({enable: [...]})` (no restart)
or you set at startup with `--caps` / `CHROME_BRIDGE_CAPS`:

| Cap | Tools |
|---|---|
| `audits` | `cookie_audit` |
| `visual` | `inject_css`, `measure_spacing`, `emulate_media`, `viewport_resize` |
| `network` | `http_auth`, `set_geolocation`, `track_events` |
| `storage` | `get_storage`, `set_storage`, `session_fixture` |
| `dom` | `modify_dom`, `watch_dom`, `drag_and_drop` |
| `files` | `save_page`, `manage_downloads`, `session_record` |
| `perf` | `animations`, `frames`, `perf_trace`, `screencast`, `lighthouse`, `heap_snapshot` |

Check what is active in your session with `get_status` → `caps_active` /
`caps_available`, and the schema cost of that set with `npm run measure`.

## Core & Navigation (13)

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

## Interaction (11)

`click`, `type_text`, `fill_form`, `hover`, `press_key`, `scroll`,
`drag_and_drop`, `upload_file`, `dismiss_overlays`, `handle_dialogs`,
`clipboard`.

`fill_form` fills N fields and submits in one call — 3 calls instead of 9 on the
benchmark form, at the same byte count.

## DOM & Inspection (11)

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

## Debugging & Network (8)

`execute_js`, `read_console`, `monitor_network` (page, browser or websocket source),
`network_rules` (block, redirect, headers, stub, and record/replay of real API responses with forced errors) (block / redirect / stub / headers),
`http_request` (sent with the user's session cookies),
`track_events` (GA4/Meta/Ads/TikTok beacons decoded from the browser log).

`execute_js` needs **Allow user scripts** enabled in the extension details.

## Visual & Responsive (5)

`element_screenshot`, `full_page_screenshot`, `screenshot_diff`,
`viewport_resize` (presets, explicit size, zoom), `emulate_media`, `set_geolocation`.

`emulate_media` has two ways in. `via: "page"` (the default for color scheme,
reduced motion and print) patches `matchMedia` in the page and, for `reduce`,
zeroes every animation: the site's own `@media (prefers-reduced-motion)` rules
never apply. `via: "debugger"` emulates as DevTools does
(`Emulation.setEmulatedMedia`), so the site's rules do apply, and adds
`contrast`, `cpu_throttle`, `network` profiles (`3g`, `slow-4g`, `fast-4g`,
`offline`), `device` (viewport with DPR, mobile) and `touch`. CDP emulation
lives only while the debugger is attached: the tab stays held, with Chrome's
debugging bar, until `emulate_media({reset: true})`. Trusted input on a held
tab reuses that session instead of detaching it.

`screenshot_diff` also takes its baseline from a PNG on disk (`from_file`): the
design mockup or a production screenshot becomes the reference; `compare_urls`
diffs two pages (production vs staging) in pixels and in text. `screenshot`
takes `presets` for one capture per viewport in a single call.
Screenshots are downscaled to ≤1568px; to read fine print, `element_screenshot`
crops a box (by `selector`, or by `region` in viewport CSS px) and enlarges it
with `scale` (1-4). Full-page captures are sliced into readable segments. `screenshot_diff` compares the current page against a named
baseline.

## Audits (2)

`audit` (accessibility, keyboard = tab order and focus issues, SEO, security headers, broken links verified server-side,
Core Web Vitals, unused CSS, `resources` = which plugin/theme/module/host slows
the page, `cache` = is the CDN serving the new version — pick the kinds,
`save_to` writes the Markdown report), `cookie_audit` (what fires before
consent).
The six former single audits stay available as CLI commands.

`extract_table` filters server-side: 236 bytes to find one row among 1500,
against 50,070 bytes for `read_page` on the same table.

## State, Storage & Files (9)

`get_storage`, `set_storage`, `session_fixture`, `http_auth`,
`save_page` (MHTML), `manage_downloads`, `session_record`, `wait_for`, `assert`.

`session_record` + `replay` run a recorded flow with no model in the loop —
the basis for CI smoke tests.

## Motion & Performance (6, cap `perf`)

`animations`, `frames`, `perf_trace`, `screencast`, `lighthouse`,
`heap_snapshot`. Results are conclusions, counts and file paths; traces,
videos and reports go to disk (`~/.config/chrome-bridge/captures/`, or
`save_to`).

- `animations` lists what runs now (CSS animations, transitions, Web
  Animations, View Transitions): selector and ref, properties, duration,
  delay, easing (`linear()` curves cut at 200 characters with their point
  count), iterations, play state, timeline (document, scroll, view).
  `composited_estimate` is a guess from the properties (transform, opacity,
  filter), not the compositor's answer; `fade_only` marks opacity-only fades.
  With `duration_ms` or `action` (click, hover, scroll, key) it records every
  animation that starts in the window: a 150 ms transition is over before a
  second call could see it.
- `frames` records for `duration_ms`: main-thread frame rate and dropped
  frames, Long Animation Frames with the scripts responsible, layout shifts
  with the elements that moved (CLS of the window), and the slowest
  interaction split into input delay, processing and presentation (INP of the
  window). INP needs `action.trusted`: synthetic events have no interaction id.
- `perf_trace` records a DevTools trace (`record` = start, reload, wait, stop;
  or `start`/`stop` around other actions) and returns LCP with its phases,
  FCP, CLS in session windows, INP, the document request, render-blocking
  resources, long tasks with the function responsible and long animation
  frames. The JSON opens in DevTools > Performance. When
  `@paulirish/trace_engine` is installed next to chrome-bridge (an optional
  peer: npm does not install it, its API is declared unstable), the
  Performance panel's insights are added.
- `screencast` records the tab to `.mp4` or `.webm` with the real timing of
  each frame (Chrome sends one only when the page changes). Needs the tab
  active and visible, and ffmpeg; without ffmpeg it returns the JPEG folder
  and the command.
- `lighthouse` (launch mode only) runs the Lighthouse CLI through `npx`
  against the launched browser, performance included: scores, the five lab
  metrics, the failing audits that weigh most. Lighthouse 13.5.0 on
  Node ≥ 22.19, 12.8.2 below.
- `heap_snapshot` (launch mode only: Chrome refuses `HeapProfiler` to
  extensions) writes a `.heapsnapshot` after a garbage collection and sums it
  up by class, with detached DOM nodes; `compare_to` an earlier file lists the
  classes that grew.

`perf_trace`, `screencast` and `emulate_media via debugger` use
`chrome.debugger` on request: Chrome shows its "started debugging this
browser" bar while they hold the tab. In launch mode nobody sees it. `frames`,
`perf_trace` and `screencast` refuse a hidden page, where rAF and observers
stop.

Checking reduced motion: `emulate_media({reducedMotion: "reduce", via:
"debugger"})`, then `animations` with the interaction (`action`) that
animates; `summary.not_fade_only` must be 0, and `max_duration_ms` short.
`emulate_media({reset: true})` at the end.

## Stateful tools

`read_console`, `monitor_network` and `watch_dom` keep
state in the extension's service worker. That worker restarts on its own: when
it does, the network log, diff baselines and HTTP auth are reset and the
monitoring call has to be re-issued.
