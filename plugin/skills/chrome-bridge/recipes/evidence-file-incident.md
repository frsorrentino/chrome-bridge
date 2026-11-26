# Evidence file for an incident (copied site, defacement, brand misuse)
Triggers: "make an evidence file on this URL", "document this for the lawyer",
"capture proof", «fai un fascicolo su questo URL», «prova per l'avvocato».
`chrome-bridge evidence --url https://copycat.example --out fascicolo/`:
full-page screenshot, DOM, visible text, HAR of the load, response headers,
page info, `manifest.json` with SHA-256 per file, `README.md` index — captured
in the user's own Chrome (logged in, real IP, no bot cloaking). Cookies, auth
headers, tokens, JWTs, password/hidden values are redacted **before** hashing.
The timestamp is the local clock: for legal value send the manifest hash via
PEC or a TSA, and say so.
