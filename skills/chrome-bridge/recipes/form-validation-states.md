# Form validation states
Triggers: "try submitting the form with wrong data".
`fill_form` with an invalid email / empty required field + `submit_selector` →
`assert({text:'required'|'obbligatorio'})` → `element_screenshot` of the
message. Then the happy path.
