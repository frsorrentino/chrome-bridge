# Efficiency: the measurement and the design behind it

## The benchmark

Same model (Claude Sonnet 5), same tasks, same morning and same `claude`
version, **all runs included** — n=5 per arm and per task, 29/09/2026, Chrome
Bridge 1.25.1 (commit `32b230c`) with its default 43 tools.
Medians, range in brackets.

| Task | Chrome Bridge | Claude in Chrome | Ratio |
| :--- | :--- | :--- | :--- |
| **Form fill** | 3.0 turns (3) / $0.155 | 14.0 turns (14-15) / $0.428 | **4.67× turns, 2.76× cost** |
| **1500-row table lookup** | 3.0 turns (3-4) / $0.149 | 7.0 turns (5-7) / $0.506 | **2.33× turns, 3.39× cost** |
| **Debug a broken page** | 3.0 turns (3-4) / $0.162 | 28.0 turns (21-44) / $0.688 | **9.33× turns, 4.25× cost** |

Correct answers: 15/15 for Chrome Bridge, 12/15 for Claude in Chrome.

The debug task is a checkout page with three causes to find: a request that
fails with 404, a JavaScript error to trace back to its source line through
the source map, and a button made invisible by an undefined CSS variable.
Chrome Bridge's `navigate` already reports the error (mapped to
`src/cart.js:10` with the line of code) and the failed request, and
`get_css_styles` flags the undefined variable: two calls, and in one run out
of five a third to read the source with `http_request`. In 1.25.0 the skill's
description also matched debugging requests and the model loaded it first in
about a third of the runs, two turns each time: 1.25.1 scopes the skill and
puts the debug rule in the server instructions. Claude in Chrome
reaches the same findings with about 14 `javascript_tool` and 4
`read_network_requests` calls per run.

On form and table Chrome Bridge is at the floor: two tool calls and the
answer. The harness favours Claude in Chrome on one point: its arm may use
`Bash` and `Read` (it read the source file from disk in the debug runs), the
Chrome Bridge arm may not.

The inclusion rule, every raw run (the six replaced after a DNS outage and
the two failed Chrome launches under machine load included, with their cause) and the harness limits are in
[bench/RESULTS.md](../bench/RESULTS.md). The previous set (27/09, 1.23.2:
2.50× turns and 1.92× cost on the form) is kept there.

## Why it wins: fewer round trips, not smaller payloads

- **Compact references.** The agent acts on short element handles (`n1`, `n2`)
  returned by `navigate` or `get_interactives`, instead of the
  screenshot → read-coordinates → click loop.
- **Batching.** `fill_form` fills N fields and submits in one call: measured, 3
  calls instead of 9 for the same form, at the same byte count.
- **Server-side processing.** Filtering a large table happens on localhost:
  `extract_table` with `where` returns 236 bytes to find one row among 1500,
  against 50,070 bytes for `read_page`. The tool-to-model payload is the token
  bottleneck, so the heavy lifting moves off it.

## The schema cost, and why it grew

The 43 core tools cost ≈11.7k tokens of `tools/list`; all 60 cost ≈15.6k
(`npm run measure`, 2026-09-28). Core is every tool used in 101 real sessions;
the 17 never used sit in six optional caps (`audits`, `visual`, `network`,
`storage`, `dom`, `files`) that the agent switches on mid-session with
`get_status({enable})`. Until 1.24 the plugin and `install.sh` forced all 60.

That core figure was ≈3.8k in 1.8.0 and roughly doubled in 1.10.0: MCP
annotations on every tool, rewritten descriptions, and a documented
`.describe()` on all 254 parameters — coverage from 35% to 100%.

The trade is deliberate and it is not free: on the form benchmark it adds ≈8% to
the cache-read tokens per turn. But the measured advantage was never prefix
size, it was round trips. For comparison, Playwright MCP's 23 core tools
measured ≈4.6k in July 2026 — on prefix size alone, that one is leaner.

Measure the active set yourself:

```bash
npm run measure          # or: node tools/measure-schema.mjs
```

## Escape hatches from the context

- `save_to` on `read_page`, `extract`, `screenshot` and `http_request` writes the
  result to a file and returns the path.
- `read_page(mode="markdown")` keeps headings, links and tables at a fraction of
  the HTML cost.
- The CLI skips MCP schemas entirely and pipes through `grep` or `jq` before
  anything reaches the model.
- Recorded flows replay without a model in the loop.
- Tools attach a capped preview of interactive elements with short refs, and
  report a `page_changed` delta only when the URL or title actually changes.
