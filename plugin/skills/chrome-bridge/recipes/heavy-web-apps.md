# Heavy web apps (Meta Ads Manager, Google Ads, big back offices)
Triggers: "change the campaign budget", "read the ad set breakdown", «modifica
la campagna su Ads Manager», «leggi i dati dell'inserzione».
Keep the tab visible first: `get_page_info` must say `visibility: 'visible'`,
else `create_tab({url, new_window:true, left, top, width, height})` on screen.
Menus without ARIA roles: `find_text({text})` on the label, not
`get_interactives` scoped by role. The app scrolls inside a panel:
`scroll({action:'until', container})` (it picks the largest scrollable panel
when the page itself does not scroll). Virtualized lists render the next rows
only after a frame: scroll in one call, click in the next. Fields that save on
Enter: `type_text` then `press_key({key:'Enter'})`. Several clicks on a React
UI: one call per click, or `execute_js` with about 350 ms between them. A
button that opens `window.open('')` navigates the tab away: override
`window.open` with `execute_js` before clicking.
