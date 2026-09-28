# Which plugin slows the page (WordPress, PrestaShop)
Triggers: "why is it slow", "which plugin slows the page", «quale plugin
rallenta la pagina?».
`audit({kinds:['resources']})` on the loaded page (reload first if it was
opened long ago): Resource Timing grouped by WordPress plugin/theme, PrestaShop module,
the site itself and each third-party host — requests, KB, time, render-blocking
count, slowest file. Then `audit({kinds:['vitals']})` for the numbers; suggest disabling the
top group and re-running both.
