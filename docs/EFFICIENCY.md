# Efficiency: the measurement and the design behind it

## The benchmark

Same model (Claude Sonnet 5), same task, paired runs on the same date and
versions, **all runs included** — n=2 per arm. A small sample: direction, not
precision.

| Task | Chrome Bridge | Claude in Chrome | Ratio |
| :--- | :--- | :--- | :--- |
| **Form fill** | 6.0 turns (6-6) / $0.211 | 16.5 turns (16-17) / $0.481 | **2.75× turns, 2.28× cost** |
| **1500-row table lookup** | see note | not re-run on this version | *not published* |

On the table-lookup task an `extract_table` fix took our side from 13.5 to 4.0
turns, but the Claude-in-Chrome arm has not been re-run on that version — so no
ratio is published for it.

The inclusion rule, every raw run (the unfavourable ones included) and the
harness limits are in [bench/RESULTS.md](../bench/RESULTS.md).

**Honest caveat:** per *turn*, Chrome Bridge costs slightly more than Claude in
Chrome — 41,985 vs 36,613 cache-read tokens, $0.0373 vs $0.0337. The win is in
the number of turns, not in the size of each one.

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

34 core tools cost ≈9.1k tokens of `tools/list`; all 63 cost ≈16.3k. Specialized
groups (`audits`, `visual`, `network`, `storage`, `dom`, `files`) are opt-in via
`--caps`.

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
