# Post-deploy check
Triggers: "did the deploy go through?", "do I still see the old CSS?".
`navigate` → `assert` on the version string (footer/meta) → `read_console({level:'error'})`
→ `audit({kinds:['cache']})`: page and main assets requested as is and with a cache-buster,
ETag/Last-Modified compared, cache status header shown. `stale` on a CSS means
the CDN still serves the old build: purge it.
