# Finding a setting in an unknown admin panel
Triggers: "where do I enable X in this theme/panel?", «trova dove si imposta X».
`find_setting({keyword:'webp'})`: follows the panel's own menu links, the
ones whose label contains the keyword first, until a page contains it, and
reports the menu path. It navigates the tab and stops at `max_pages`. Not
found → try a synonym, a wider `menu_selector`, or `find_text` on the page
the user points at.
