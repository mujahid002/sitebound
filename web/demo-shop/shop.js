// Cart and checkout for the demo shop. The only payment code is the <sitebound-pay> element:
// the payee comes from the on-chain registry entry for this page's origin, not from here.

const EXPLORER = 'https://explorer.testnet.whitechain.io';
const HERE = document.currentScript.src;
const cart = new Map(); // sku -> { name, cents, qty }
let current = null; // the open checkout: { order, amount }, set by this page, not by the payment event
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
  current = { order, amount: fmt(totalCents()) };
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

// Page script can fire `sitebound:paid` too, so the shop ships only when the chain says this order was paid
// this amount, to this site. A real website does this on its server.
async function paid({ txHash, paymentId }) {
  const want = current;
  $('pay').hidden = true;
  $('checkout').hidden = true;
  $('done').hidden = false;
  $('done-link').hidden = true;
  $('done-title').textContent = 'Checking the payment…';
  $('done-text').textContent = 'Asking Whitechain, not the page.';
  let r;
  try {
    const { verifyPayment } = await import(new URL('../merchant/sitebound-merchant.mjs', HERE).href);
    const C = window.SITEBOUND;
    r = await verifyPayment({ rpcUrl: C.rpcUrl, contract: C.address, expectedSite: location.origin, expectedAmount: want.amount, orderId: want.order, paymentId });
  } catch {
    r = { ok: false, reason: 'Whitechain could not be reached' };
  }
  if (!r.ok) {
    $('done-title').textContent = 'Not shipped';
    $('done-text').textContent = `The page said order ${want.order} was paid. The chain says: ${r.reason}.`;
    return;
  }
  $('done-title').textContent = 'Order confirmed';
  $('done-text').textContent = `Thanks. Order ${want.order} is paid: ${want.amount} USDT, checked on Whitechain.`;
  $('done-tx').href = `${EXPLORER}/tx/${txHash}`;
  $('done-link').hidden = false;
  cart.clear();
  render();
  $('checkout').hidden = true;
}

// What a hacked script on this page could do: claim the order is paid. The check above refuses it.
$('forge').onclick = () => {
  const btn = $('pay-slot').querySelector('sitebound-pay');
  const fake = '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  btn?.dispatchEvent(new CustomEvent('sitebound:paid', { detail: { orderId: current.order, txHash: fake, paymentId: fake } }));
};

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
