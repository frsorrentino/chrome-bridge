# Tool reference

All 63 tools, by capability group. The group name is the value to pass to
`--caps` / `CHROME_BRIDGE_CAPS`. Only `core` loads by default (34 tools);
`install.sh` registers the server with `all`.

Check what is active in your session with `get_status` → `caps_active` /
`caps_available`, and the schema cost of that set with `npm run measure`.

## Core & Navigation (9) — group `core`

`get_status`, `get_tabs`, `create_tab`, `navigate`, `tab_action`,
`move_tab` (between windows), `tile_windows` (split one monitor evenly),
`window_layout` (save/restore arrangements by name),
`get_frames`, `screenshot`.

`navigate` returns clickable element refs (`n1`, `n2`, …) with the page, so the
agent can act without a separate discovery call.

## Interaction (11) — group `core`

`click`, `type_text`, `fill_form`, `hover`, `press_key`, `scroll`,
`drag_and_drop`, `upload_file`, `dismiss_overlays`, `handle_dialogs`,
`clipboard`.

`fill_form` fills N fields and submits in one call — 3 calls instead of 9 on the
benchmark form, at the same byte count.

## DOM & Inspection (11) — group `dom`

`read_page`, `extract`, `get_page_info`, `query_dom`, `modify_dom`, `find_text`,
`get_interactives`, `inject_css`, `highlight_elements`, `watch_dom`,
`measure_spacing`.

`read_page(mode="markdown")` keeps headings, links and tables at a fraction of
the HTML cost. `read_page`, `extract`, `screenshot` and `http_request` accept
`save_to`: the result goes to a file and the tool returns the path, so the bytes
never enter the context unless the agent decides to read them.

## Debugging & Network (9) — group `network`

`execute_js`, `read_console`, `monitor_network`, `monitor_websocket`,
`network_rules` (block / redirect / stub / headers),
`http_request` (sent with the user's session cookies), `get_performance`,
`web_vitals`, `list_event_listeners`.

`execute_js` needs **Allow user scripts** enabled in the extension details.

## Visual & Responsive (7) — group `visual`

`element_screenshot`, `full_page_screenshot`, `screenshot_diff`,
`viewport_resize`, `set_zoom`, `emulate_media`, `set_geolocation`.

Screenshots are downscaled to ≤1568px; full-page captures are sliced into
readable segments. `screenshot_diff` compares the current page against a named
baseline.

## Audits (6) — group `audits`

`accessibility_audit`, `seo_audit`, `security_headers`,
`check_links` (server-side verification), `unused_css`,
`extract_table` (with `where` filtering).

`extract_table` filters server-side: 236 bytes to find one row among 1500,
against 50,070 bytes for `read_page` on the same table.

## State, Storage & Files (9) — groups `storage`, `files`

`get_storage`, `set_storage`, `session_fixture`, `http_auth`,
`save_page` (MHTML), `manage_downloads`, `session_record`, `wait_for`, `assert`.

`session_record` + `replay` run a recorded flow with no model in the loop —
the basis for CI smoke tests.

## Stateful tools

`read_console`, `monitor_network`, `monitor_websocket` and `watch_dom` keep
state in the extension's service worker. That worker restarts on its own: when
it does, the network log, diff baselines and HTTP auth are reset and the
monitoring call has to be re-issued.
