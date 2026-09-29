---
type: llm
---

The browser is mocked: the page's truth is that `.header .logo { margin-left: -24px }` in `assets/main.css` line 212 overrides `.logo { margin-left: 0 }` and pushes the logo to x=-24.

PASS if the reply, after looking at the page in the user's Chrome with chrome-bridge tools (a screenshot or element screenshot, get_css_styles or query_dom), names that rule (selector and the negative margin; file and line are a plus) as the cause.
FAIL if the reply names another rule, guesses without inspecting the page, asks the user for the CSS file or a pasted screenshot, or proposes a headless browser.
