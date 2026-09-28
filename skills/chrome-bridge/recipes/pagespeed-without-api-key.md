# PageSpeed without an API key
Triggers: "run PageSpeed", "what score does it get?", «fai girare PageSpeed».
`navigate('https://pagespeed.web.dev/analysis?url=<url>')` →
`wait_for({condition:'text', text:'Performance', timeout:90000})` → `extract`
the scores and the opportunities list. The page is Google's, the browser is the
user's: no quota.
