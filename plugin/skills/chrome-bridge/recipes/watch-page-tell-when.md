# Watch a page and tell me when
Triggers: "tell me when the pipeline is green", "warn me when the Approve
button appears", "when this price changes", «avvisami quando…».
`watch({name:'deploy', text:'Deployed', interval_s:60, expires_min:240, reload:true})`
(or `selector`, or `value_of` for a changing number). The extension checks
on its own; nothing wakes the model. Delivery is explicit: later
`watch({action:'poll'})` in this session, or a script that blocks on
`chrome-bridge watch --wait deploy --timeout 3600 && <notify: telegram-send,
notify-send, a hook>`. Say which one you set up. `watch({action:'list'})`,
`watch({action:'remove', name})`.
