# Three viewports
Triggers: "check it on mobile/tablet/desktop", «com'è su telefono?».
`screenshot({presets:['mobile','tablet','desktop'], save_to:'./shots'})`: one
call, one file per viewport, window restored. Presets resize the window and
do not emulate a phone: a width the window manager refuses comes back as
`NOT APPLIED`, with no image — say so instead of judging the mobile layout.
Report overflow, overlapping elements, hidden CTAs. Dark mode: `emulate_media({colorScheme:'dark'})`.
Print stylesheet: `emulate_media({printMode:true})` then `screenshot`.
