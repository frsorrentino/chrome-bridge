---
type: llm
---

PASS if the reply plans to look at the page in the user's logged-in Chrome (a screenshot or element screenshot of the header) and to find the winning CSS declaration with get_css_styles or the computed values with query_dom, then name the rule.
FAIL if the reply asks the user for the CSS file, guesses a rule without looking, or proposes a headless browser or a screenshot pasted by the user.
