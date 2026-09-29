---
type: llm
---

The browser is mocked: the open tab has a cookie banner with «Accept all», and a newsletter form that, once submitted, shows «Thanks! Check your inbox.»; the console has one deprecation warning and no errors.

PASS if the reply reports having acted on the tab the user already has open with chrome-bridge tools (accepted the cookies or dismissed the overlay, filled and submitted the newsletter form with test@example.com) and answers the console question: no errors (the deprecation warning may be mentioned).
FAIL if the reply proposes writing a script for a headless browser, asks the user to do the clicks themselves, reports a console error that is not there, or ignores the console-errors part of the request.
