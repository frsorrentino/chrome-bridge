# Efficiency: the measurement and the design behind it

## The benchmark

Same model (Claude Sonnet 5), same task, same day and same `claude` version,
**all runs included** — n=5 per arm and per task, 27/09/2026, Chrome Bridge
1.23.2. Medians, range in brackets.

| Task | Chrome Bridge | Claude in Chrome | Ratio |
| :--- | :--- | :--- | :--- |
| **Form fill** | 6.0 turns (4-6) / $0.225 | 15.0 turns (10-16) / $0.432 | **2.50× turns, 1.92× cost** |
| **1500-row table lookup** | 6.0 turns (4-6) / $0.217 | 7.0 turns (7-9) / $0.501 | **1.17× turns, 2.31× cost** |

On the table lookup the gain is cost, not turns: Claude in Chrome reads the
page text (40 KB into the context) and counts the rows in JavaScript, and it
re-reads that text on every turn. Chrome Bridge answers with one
`extract_table` call that returns 0.2 KB. Correct answers: 10/10 for Chrome
Bridge, 9/10 for Claude in Chrome.

The same day's runs on 1.23.0 found five defects that cost turns or answers;
fixing them in 1.23.1 and 1.23.2 took Chrome Bridge from 8/10 to 10/10 correct
answers. In 3 runs out of 5 per task the model loads the chrome-bridge skill
first, which costs 2 turns: without it the runs take 4 turns.

The inclusion rule, every raw run (the unfavourable ones included) and the
harness limits are in [bench/RESULTS.md](../bench/RESULTS.md).

**Honest caveat:** on the form, per *turn*, Chrome Bridge costs more than Claude
in Chrome — about 45k vs 42k cache-read tokens, $0.037 vs $0.029 (27/09/2026).
The win there is in the number of turns, not in the size of each one. On the
table lookup it is the other way round: about the same turns, each one cheaper
(45k vs 65k cache-read tokens).

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
