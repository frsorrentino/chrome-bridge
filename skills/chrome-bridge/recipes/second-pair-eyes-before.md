# Second pair of eyes before an irreversible submit
Triggers: "check the form before I send it", "does this match the documents?",
"review what I filled in", «controlla il modulo prima che invio».
`read_form()` (or `read_form({selector:'form#suap'})`): every control with
label, value, checked, required-but-empty, browser validity; passwords and
cards `[redacted]`. Compare each value with the source of truth in the project
(IBAN, fiscal code, amounts, addresses, the signed quote) and with the domain
checklist (Ads: negative keywords, location targeting; WooCommerce: tax class;
DNS: record type and TTL). Answer with what does not match and what you could
not check — never a bare "all good". On request only, not continuous.
