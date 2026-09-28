// Checkout cart: loads the cart from the API and renders its items.
async function loadCart() {
  const res = await fetch('/api/cart');
  const data = res.ok ? await res.json() : undefined;
  renderCart(data);
}

function renderCart(cart) {
  const list = document.querySelector('#items');
  for (const item of cart.items) {
    list.insertAdjacentHTML('beforeend', `<li>${item.name}<span>${item.price}</span></li>`);
  }
}

loadCart().catch((err) => console.error('Cart failed to load:', err.stack));
