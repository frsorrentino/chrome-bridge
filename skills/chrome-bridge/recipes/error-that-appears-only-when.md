# Error that appears only when logged in
Triggers: "it works as anonymous, breaks as admin", «l'errore compare solo da
loggato».
1. The tab is already logged in: `read_console({level:'error', clear:true})`.
2. Reproduce: the `click`/`fill_form` the user describes.
3. `read_console({level:'error'})` + `monitor_network({source:'page'})` and
   look for 4xx/5xx and failed XHR.
4. Compare with a private window the user opens, or with `session_fixture`
   restored to a clean state.
Report the exact message, the request that failed, and the user role.
