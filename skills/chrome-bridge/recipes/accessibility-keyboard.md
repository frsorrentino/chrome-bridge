# Accessibility and keyboard navigation
Triggers: "run an accessibility audit", "can it be used with the keyboard?",
"is the tab order right?", "does the modal trap focus?", «si naviga da tastiera?».
`audit({kinds:['a11y']})` for the rules; `audit({kinds:['keyboard']})` for what
a keyboard user meets: focus refused, off-screen, no visible indicator, focus
escaping an open modal. It uses computed tab order and programmatic focus, not
real Tab keys — report a trap as "not exercised", not as "works".
