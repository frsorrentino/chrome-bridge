# Page audit before a release
Triggers: "audit this page", "check it before we go live", "prepare the site
report for the client", «fai un audit», «prepara il report del sito».
`audit({save_to:'./audit-<page>.md'})` runs accessibility, SEO, security
headers, broken links and Core Web Vitals in one call (add `'css'` to `kinds`
for unused selectors: slow, approximate). Chat gets one line per kind; the
file has every finding, ready for the PR or the client.
