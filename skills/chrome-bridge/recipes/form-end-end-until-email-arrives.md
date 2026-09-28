# Form end to end, until the email arrives
Triggers: "check that the form works / that the email arrives", "does the
contact form send the notification?", «verifica che la mail arrivi».
1. `fill_form({fields, submit_selector})` with test values that carry a marker
   (e.g. subject `TEST-1730`).
2. `assert({text:'thank you'|'grazie'})` on the confirmation.
3. `navigate` to the webmail the user is logged into (Gmail, Outlook) or the
   transactional provider log (Brevo, Mailgun, SendGrid).
4. `wait_for({condition:'text', text:'TEST-1730', timeout:120000})`, then
   `find_text('TEST-1730')` → open it → `extract` the body.
5. Not found: check the spam folder, then the provider log. Report: sent, time
   to arrive, folder, sender shown, and anything missing from the body.
