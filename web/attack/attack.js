// Shared by the attack pages: an on-page log, the "inject" toggle and the copy button.

window.demoLog = (msg) => {
  const li = document.createElement('li');
  li.textContent = msg;
  document.getElementById('log').append(li);
};

const injectBtn = document.getElementById('inject');
if (injectBtn) {
  injectBtn.onclick = () => {
    const s = document.createElement('script');
    s.src = 'inject.js';
    document.body.append(s);
    injectBtn.disabled = true;
    injectBtn.textContent = 'Hacked script injected';
    document.body.classList.add('hacked');
  };
}

for (const el of document.querySelectorAll('[data-copy]')) {
  el.onclick = async () => {
    try {
      await navigator.clipboard.writeText(el.dataset.copy);
      el.textContent = 'Copied';
    } catch (e) {
      el.textContent = 'Copy failed';
    }
    setTimeout(() => (el.textContent = 'Copy'), 1500);
  };
}

// Same order id scheme as the demo shop: unique per checkout.
const slot = document.getElementById('pay-slot');
if (slot) {
  const rand = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
  const order = `HCS-${Date.now().toString(36)}-${rand}`.toUpperCase();
  const btn = document.createElement('sitebound-pay');
  btn.setAttribute('amount', slot.dataset.amount);
  btn.setAttribute('order', order);
  btn.addEventListener('sitebound:paid', (e) => window.demoLog(`paid: order ${e.detail.orderId}, tx ${e.detail.txHash}`));
  slot.append(btn);
  window.demoLog(`checkout rendered: amount ${slot.dataset.amount}, order ${order}`);
}

const tamper = document.getElementById('tamper');
if (tamper) {
  tamper.onclick = () => {
    // Re-render rather than setAttribute: a hacked script would set the amount before the button loads.
    const old = document.querySelector('sitebound-pay');
    const btn = document.createElement('sitebound-pay');
    btn.setAttribute('amount', '49.00');
    btn.setAttribute('order', old.getAttribute('order'));
    old.replaceWith(btn);
    tamper.disabled = true;
    window.demoLog('page code re-rendered the button with amount 49.00. The buyer sees 49.00 in the frame and must confirm it; caps still apply. The payee is unchanged.');
  };
}

const overlay = document.getElementById('overlay-toggle');
if (overlay) {
  overlay.onclick = () => {
    const on = document.body.classList.toggle('redress');
    overlay.textContent = on ? 'Remove the overlay' : 'Draw the overlay';
  };
}

const here = document.getElementById('here');
if (here) here.textContent = location.origin;
