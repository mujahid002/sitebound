// Cart and checkout for the demo shop. The only payment code is the <sitebound-pay> element:
// the payee comes from the on-chain registry entry for this page's origin, not from here.

const cart = new Map(); // sku -> { name, cents, qty }
const $ = (id) => document.getElementById(id);

// Prices are kept in integer cents so the amount attribute is always exact, e.g. "16.50".
const fmt = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

function totalCents() {
  let t = 0;
  for (const l of cart.values()) t += l.cents * l.qty;
  return t;
}

// Order ids must be unique per site (the contract rejects a reused one), so every checkout gets a new one.
function newOrderId() {
  const rand = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
  return `HCS-${Date.now().toString(36)}-${rand}`.toUpperCase();
}

function render() {
  const lines = $('lines');
  lines.replaceChildren();
  let count = 0;
  for (const [sku, l] of cart) {
    count += l.qty;
    const li = document.createElement('li');
    li.innerHTML = '<span class="name"></span><span class="qty"><button type="button" aria-label="Remove one">-</button><span></span><button type="button" aria-label="Add one">+</button></span><b></b>';
    li.querySelector('.name').textContent = l.name;
    li.querySelector('.qty span').textContent = l.qty;
    li.querySelector('b').textContent = fmt(l.cents * l.qty);
    const [minus, plus] = li.querySelectorAll('button');
    minus.onclick = () => change(sku, -1);
    plus.onclick = () => change(sku, 1);
    lines.append(li);
  }
  $('cart-count').textContent = count;
  $('empty').hidden = count > 0;
  $('total').textContent = `${fmt(totalCents())} USDT`;
  $('checkout').disabled = count === 0;
}

function change(sku, by) {
  const l = cart.get(sku);
  l.qty += by;
  if (l.qty <= 0) cart.delete(sku);
  closeCheckout(); // a changed cart needs a new amount and a new order id
  render();
}

function add(card) {
  const { sku, name, cents } = card.dataset;
  const l = cart.get(sku) || { name, cents: Number(cents), qty: 0 };
  l.qty += 1;
  cart.set(sku, l);
  closeCheckout();
  render();
}

function openCheckout() {
  const order = newOrderId();
  const btn = document.createElement('sitebound-pay');
  btn.setAttribute('amount', fmt(totalCents()));
  btn.setAttribute('order', order);
  // Listen on the element itself; whether the event bubbles is up to the button.
  btn.addEventListener('sitebound:paid', (e) => paid(e.detail));
  $('pay-slot').replaceChildren(btn);
  $('order-id').textContent = order;
  $('pay').hidden = false;
  $('checkout').hidden = true;
}

function closeCheckout() {
  $('pay-slot').replaceChildren();
  $('pay').hidden = true;
  $('checkout').hidden = false;
}

function paid({ orderId, txHash }) {
  const explorer = (window.SITEBOUND && window.SITEBOUND.explorer) || 'https://explorer.testnet.whitechain.io';
  $('done-order').textContent = orderId;
  $('done-tx').href = `${explorer}/tx/${txHash}`;
  $('done').hidden = false;
  $('pay').hidden = true;
  cart.clear();
  render();
  $('checkout').hidden = true;
}

for (const card of document.querySelectorAll('#products .card')) {
  card.querySelector('button').onclick = () => add(card);
}
$('checkout').onclick = openCheckout;
$('again').onclick = () => {
  $('done').hidden = true;
  closeCheckout();
  render();
};
render();
