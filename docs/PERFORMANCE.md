# Latency per tool

Measured 2026-09-11 on the real path: stdio MCP client → server → WebSocket → extension → page, 5 rounds per tool (medians), local pages (bench/form.html, bench/heavy.html), headless launch mode. Environment: Node v24.13.1, Chrome 152.0.0.0, extension 1.17.0, server 1.17.0, linux arm64. Nothing here is estimated: every number came out of `npm run bench:latency`.

Cold start, spawn → extension connected: 4631 ms.

| Tool | min | median | p95 | max | Note |
|---|---:|---:|---:|---:|---|
| `get_status` | 7 | 8 | 16 | 16 | transport only, no page |
| `get_tabs` | 14 | 33 | 51 | 51 | transport + tab query |
| `navigate` | 138 | 149 | 620 | 620 | form.html, load + interactives preview |
| `get_page_info` | 11 | 13 | 23 | 23 | metas, scripts, links, forms |
| `read_page` | 11 | 14 | 22 | 22 | form.html as text |
| `get_interactives` | 13 | 14 | 20 | 20 | form.html, 7 controls |
| `find_text` | 21 | 29 | 58 | 58 | one match |
| `query_dom` | 20 | 24 | 29 | 29 | 5 inputs with a computed style |
| `wait_for` | 15 | 16 | 20 | 20 | element already present |
| `scroll` | 14 | 14 | 18 | 18 | scroll to the submit button |
| `click` | 184 | 197 | 213 | 213 | a label: focuses a field, no navigation |
| `type_text` | 16 | 18 | 23 | 23 | native setter |
| `fill_form` | 41 | 49 | 50 | 50 | two fields, no submit |
| `screenshot` | 449 | 515 | 552 | 552 | viewport PNG, base64 |
| `element_screenshot` | 496 | 514 | 527 | 527 | the form, cropped |
| `read_console` | 15 | 18 | 19 | 19 | buffer read |
| `execute_js` | 15 | 19 | 21 | 21 | trivial expression |
| `navigate` | 468 | 537 | 729 | 729 | heavy.html, 1500-row table |
| `extract_table` | 136 | 151 | 176 | 176 | 1500 rows, server-side where |
| `read_page` | 19 | 22 | 27 | 27 | heavy.html as text |

Milliseconds, rounded. p95 is nearest-rank (the sample of rank ceil(0.95·n)): with 5 rounds it is the maximum. ⚠ marks a median above 2000 ms, the budget declared for a tool on a static local page: a call that sits on a timeout is a bug of this class, not a slow page.
