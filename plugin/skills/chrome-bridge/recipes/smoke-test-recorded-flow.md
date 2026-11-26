# Smoke test of a recorded flow, and a Playwright test out of it
Triggers: "re-run the login flow and tell me if it passes", "turn what you just
did into a test", "I want this in CI", «fammene un test Playwright».
`session_record({action:'start', name})` … actions … `session_record({action:'stop'})`
then, with no model in the loop: `chrome-bridge replay --file <path>` and
`chrome-bridge assert --selector "#ok" --text "Done"`. For CI without the
bridge: `session_record({action:'export', name})` → `<name>.spec.ts` with
`page.goto/fill/click/expect`, human steps as `page.pause()`, and a header
saying the login state is not exported (use `storageState`). Zero-token:
`chrome-bridge export --file flow.jsonl --out tests/flow.spec.ts`.
