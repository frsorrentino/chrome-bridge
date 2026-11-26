# Cookies and the consent banner
Triggers: "is the consent banner compliant?", "what fires before consent?",
«audit dei cookie e del banner».
`cookie_audit({accept_selector:'#accept'})` (omit the selector to let the
overlay dismisser find the button; `'none'` to skip consent): it clears the
site's cookies, reloads, records cookies and third-party hosts **before**
consent, accepts, records again. The findings name the tracking hosts
contacted before consent — the part a regulator asks about. Warn the user:
it logs them out of the audited site.
