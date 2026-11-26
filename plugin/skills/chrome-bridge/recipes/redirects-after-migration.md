# Redirects after a migration
Triggers: "check the migration redirects", "do the old URLs reach the new
ones?", «verifica i redirect della migrazione».
A CSV with `old,new` per line, then `chrome-bridge redirects --csv map.csv`:
one line per URL (`ok` / `mismatch` / `error`, status, final URL), exit code 1
if anything is off, cookies of the logged-in session included. Read back only
the non-ok lines. A single URL: `http_request({url})` → status and final URL.
