# Latency per tool

Measured 2026-09-11 on the real path: stdio MCP client → server → WebSocket → extension → page, 5 rounds per tool (medians), local pages (bench/form.html, bench/heavy.html), headless launch mode. Environment: Node v24.13.1, Chrome 152.0.0.0, extension 1.16.1, server 1.16.1, linux arm64. Nothing here is estimated: every number came out of `npm run bench:latency`.

Cold start, spawn → extension connected: 11245 ms.

| Tool | min | median | p95 | max | Note |
|---|---:|---:|---:|---:|---|
| `get_status` | 3 | 4 | 5 | 5 | transport only, no page |
| `get_tabs` | 11 | 14 | 16 | 16 | transport + tab query |
| `navigate` | 103 | 158 | 213 | 213 | form.html, load + interactives preview |
| `get_page_info` | 16 | 16 | 23 | 23 | metas, scripts, links, forms |
| `read_page` | 10 | 14 | 18 | 18 | form.html as text |
| `get_interactives` | 14 | 17 | 25 | 25 | form.html, 7 controls |
| `find_text` | 25 | 40 | 45 | 45 | one match |
| `query_dom` | 13 | 13 | 17 | 17 | 5 inputs with a computed style |
| `wait_for` | 11 | 12 | 44 | 44 | element already present |
| `scroll` | 12 | 13 | 15 | 15 | scroll to the submit button |
| `click` | 21 | 21 | 43 | 43 | a label: focuses a field, no navigation |
| `type_text` | 12 | 17 | 21 | 21 | native setter |
| `fill_form` | 37 | 39 | 45 | 45 | two fields, no submit |
| `screenshot` | 437 | 447 | 456 | 456 | viewport PNG, base64; error: This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota. |
| `element_screenshot` | 433 | 485 | 536 | 536 | the form, cropped; error: This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota. |
| `read_console` | 15 | 19 | 27 | 27 | buffer read |
| `execute_js` | 9 | 11 | 18 | 18 | trivial expression |
| `navigate` | 518 | 603 | 767 | 767 | heavy.html, 1500-row table |
| `extract_table` | 78 | 108 | 219 | 219 | 1500 rows, server-side where |
| `read_page` | 29 | 29 | 33 | 33 | heavy.html as text |

Milliseconds, rounded. p95 is nearest-rank (the sample of rank ceil(0.95·n)): with 5 rounds it is the maximum. ⚠ marks a median above 2000 ms, the budget declared for a tool on a static local page: a call that sits on a timeout is a bug of this class, not a slow page.
