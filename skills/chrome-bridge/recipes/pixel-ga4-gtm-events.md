# Pixel, GA4, GTM events
Triggers: "does the pixel fire the right events?", "does GTM send purchase?",
«verifica che il pixel spari gli eventi giusti».
`track_events({clear:true})` right before the action, the action, then
`track_events({wait_ms:5000})`: one line per beacon — vendor, event, key
params (value, currency, ids), time since the first. Params sent in a POST
body are flagged, not decoded. `execute_js('JSON.stringify(window.dataLayer)')`
for the data layer. Zero-token: `chrome-bridge track --clear --wait-ms 8000`.
