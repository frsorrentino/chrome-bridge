---
type: llm
---

PASS if the reply plans to act on the tab the user already has open (click the consent button or dismiss the overlay, fill the form in one call, submit, then read the console for errors) with chrome-bridge tools, in that order.
FAIL if the reply proposes writing a script for a headless browser, asks the user to do the clicks themselves, or ignores the console-errors part of the request.
