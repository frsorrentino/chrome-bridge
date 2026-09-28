# Watch how I do it (learn a procedure from the user)
Triggers: "watch how I do it", "learn this procedure", "I'll show you once",
«guarda come faccio», «te lo faccio vedere una volta».
`session_record({action:'observe', name:'renew-domain'})` on the tab the user
will use — a badge marks it. They do the task; then
`session_record({action:'stop'})` writes `<name>.jsonl` (replayable) and
`<name>.md` (numbered steps, human-only steps marked `[HUMAN]`). Password,
card, IBAN, token fields are never recorded: `{{field}}` placeholders, filled
with `--vars` at replay or by the person. `values:true` records the other
fields' values. Next time: `chrome-bridge replay --file …` or
`session_record({action:'export'})` for Playwright.
