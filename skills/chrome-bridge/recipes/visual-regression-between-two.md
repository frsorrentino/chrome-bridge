# Visual regression between two runs, or two URLs
Triggers: "did anything change visually?", "compare staging with production",
"what changed in this PR preview?", «confronta staging e produzione».
Same page over time: `screenshot_diff({action:'baseline', name})` before,
`screenshot_diff({action:'compare', name})` after. Two URLs (logged-in pages
too): `screenshot_diff({action:'compare_urls', url_a:'https://prod', url_b:'https://staging', mask:['.date','.carousel']})`
→ changed-pixel %, the diff image, and the text lines only in A / only in B —
often enough to decide without looking at pixels. Baselines live in the
extension's memory until it restarts.
