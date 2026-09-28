# Console errors after an action
Triggers: "click X and tell me if there are errors".
`read_console({clear:true})` → `click({selector|ref, wait_after:'networkidle'})`
→ `read_console({level:'error'})`. Empty with `hooked:false` means the hook
isn't installed: reload the page first.
