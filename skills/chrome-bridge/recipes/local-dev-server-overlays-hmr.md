# Local dev server: overlays, HMR, readable stack traces
Triggers: "why is the page blank on localhost", "Vite shows an error", "where
does this error come from in the source", «l'errore in console non dice il file».
`get_page_info()` reports `dev.server` (vite, webpack-dev-server, next, nuxt)
and `dev.overlay` with the compiler's message when an error overlay is open —
read that before treating the page as valid. `read_console({level:'error', sourcemap:true})`
appends `src/file.ts:line:col (function)` to `bundle.js:1:284913` frames by
fetching the source maps through the browser (localhost and logged-in hosts
alike). On HMR-heavy pages, `monitor_network` shows the dev WebSocket too:
filter it out mentally.
