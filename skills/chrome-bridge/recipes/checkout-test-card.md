# Checkout with a test card
Triggers: "test the checkout", "place a test order", «testa il checkout con la
carta di prova».
1. Add a product, go to checkout, `fill_form` the address.
2. Card fields live in an iframe: `get_frames()` → `fill_form({frame_id, fields})`.
   Only provider **test** numbers (Stripe `4242 4242 4242 4242`, PayPal
   sandbox). Refuse anything that looks like a real card.
3. `wait_for` the 3-D Secure test modal, `click` its approve button.
4. `assert({text:'order received'|'ordine ricevuto'})`, then the order in the
   back office (`navigate` + `find_text` of the order number).
Report: order number, total, payment status, emails sent (recipe above).
