---
type: llm
---

The browser is mocked: on the page, the fixed `aside.sidebar` spans x=0..280 and `table#orders` starts at x=240, so the sidebar covers the first 40 px of the table (the «Order #» column).

PASS if the reply, after taking the screenshot in the user's own Chrome with a chrome-bridge tool, answers that yes, the sidebar overlaps the orders table (about 40 px, or the first column cut).
FAIL if the reply says there is no overlap, proposes a headless browser, Playwright, Puppeteer or Selenium, gives a generic "I cannot see your screen" answer, or asks the user to paste the HTML.
