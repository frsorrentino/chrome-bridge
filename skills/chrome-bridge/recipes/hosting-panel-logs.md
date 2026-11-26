# Hosting panel logs (SiteGround, Plesk, cPanel)
Triggers: "read the hosting error log", «leggi il log errori dell'hosting».
The panel is already logged in. `navigate` to the panel → `find_text('error log'|'Logs')`
→ `click` its ref → `extract_table({where:{message:'/fatal|warning/'}})` or
`extract`; long logs: `save_page({save_to})` and read the file. Report the last
errors with time and file path.
