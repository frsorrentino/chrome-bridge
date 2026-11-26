# Design tokens, fonts and colours against the mockup
Triggers: "does it use the design's fonts/colours?", "does it match the
Figma?", «somiglia al design?».
`query_dom({selector, properties:['font-family','font-size','color','background-color','margin','padding']})`
on the key elements; compare with the token file in the repo. Why a value is
what it is («chi mi azzera il margine?»): `get_css_styles({selector, properties:['margin-top']})`
→ the winning rule with selector, stylesheet and rule position, plus the ones it
overrides; `include_inherited:true` for `color` and `font-*`. Spacing between
two elements: `measure_spacing({selector1, selector2})`. Visual comparison:
`viewport_resize({width, height})` to the mockup's size, then
`screenshot_diff({action:'baseline', name:'home', from_file:'./mockups/home.png'})`
and `screenshot_diff({action:'compare', name:'home'})` → changed-pixel % and a
highlighted diff; zoom into a region with `element_screenshot({region, scale:2})`.
