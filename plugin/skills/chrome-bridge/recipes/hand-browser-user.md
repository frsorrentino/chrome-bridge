# Hand the browser to the user
Triggers: "log in for me" (no: hand it over), "there's a CAPTCHA", "ask me
which element", "wait until I'm done", «fai il login tu» → handoff, «quale
bottone intendo? guardalo».
`handoff({message:'Complete the login with your 2FA, then press Done', timeout:300000})`
→ returns `done`, `cancel` or `timeout` with the URL the tab ended on. For a
choice: `handoff({message:'Click the button you mean', pick_element:true})` →
selector, text and box of the element clicked; use the selector in the next
`click`/`element_screenshot`. On `timeout`, ask before retrying.
