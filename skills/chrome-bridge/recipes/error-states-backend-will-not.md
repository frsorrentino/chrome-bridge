# Error states the backend will not produce
Triggers: "what does the UI do if the API returns 500 / times out / returns an
empty list?", "test the error state", «testa lo stato d'errore».
With `monitor_network({source:'page'})` on, load the page so it fetches its
APIs, then `network_rules({action:'record', name:'catalog', url_filter:'||shop.it/api/*'})`
(re-fetches those URLs now, with the user's cookies, into a fixture). Then
`network_rules({action:'replay', name:'catalog', overrides:[{url_contains:'/api/items', status:500, latency_ms:3000}]})`,
reload, `screenshot`/`assert` the error UI. `network_rules({action:'clear'})`
restores the real backend. A single URL with a hand-written body:
`network_rules({action:'stub', url_filter, body, status})`.
