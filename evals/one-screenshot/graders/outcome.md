---
type: llm
---

PASS if the reply sets out to take the screenshot in the user's own Chrome (the tab they already have, or a tab it opens there) using a chrome-bridge tool or the chrome-bridge CLI, and says how it will judge the overlap (element_screenshot / query_dom / measure_spacing, or a pixel comparison) rather than asking the user to describe the page.
FAIL if the reply proposes a headless browser, Playwright, Puppeteer, Selenium or a generic "I cannot see your screen" answer, or asks the user to paste the HTML.
