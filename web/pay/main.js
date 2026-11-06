// Pay link maker: builds a snippet and a standalone pay.html from site + amount + order.
// Nothing here is signed or sent anywhere; the generated page does the paying, on the owner's own origin.
const C = window.SITEBOUND;
const $ = (id) => document.getElementById(id);
const BUTTON = `${C.frameOrigin}/button/sitebound.js`;
const q = new URLSearchParams(location.search);

// ------------------------------------------------------------------ validation (mirrors the frame and onboard/lib.js)
function checkSite(raw) {
  raw = raw.trim();
  if (!raw) return { empty: true };
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return { error: 'That is not a web address.' }; }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return { error: 'Use an https:// address.' };
  if (u.origin !== raw) return { error: `Use the bare origin, exactly: ${u.origin}`, fix: u.origin };
  return { origin: u.origin };
}
const checkAmount = (v) => !v.trim() ? { empty: true }
  : /^\d{1,12}(\.\d{1,6})?$/.test(v.trim()) && Number(v) > 0 ? { amount: v.trim() }
  : { error: 'Use a number above zero, up to 6 decimals, like 12.00' };
const checkOrder = (v) => !v ? { empty: true }
  : /^[\x20-\x7e]{1,64}$/.test(v) ? { order: v }
  : { error: 'Use 1 to 64 plain keyboard characters.' };

// ------------------------------------------------------------------ templates
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const snippet = (amount, order) =>
`<script src="${BUTTON}" defer></script>
<sitebound-pay amount="${esc(amount)}" order="${esc(order)}"></sitebound-pay>`;

function pageHtml({ origin, amount, order, dyn }) {
  const host = new URL(origin).host;
  const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Pay ${esc(host)}</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 440px; margin: 0 auto; padding: 56px 20px; display: grid; gap: 16px; justify-items: start; }
  h1 { margin: 0; font-size: 1.5rem; letter-spacing: -0.02em; }
  p { margin: 0; opacity: .75; }
  #status { min-height: 1.5em; }
</style>
<script src="${BUTTON}" defer></script>
</head>
<body>
<main>
  <h1>Pay ${esc(host)}</h1>`;
  const tail = `
  <p id="status" role="status"></p>
</main>
<script>
  document.addEventListener('sitebound:paid', (e) => {
    document.getElementById('status').textContent = 'Paid. Reference ' + e.detail.paymentId;
  });
</script>
</body>
</html>
`;
  if (!dyn) return `${head}
  <p>Order ${esc(order)}</p>
  <sitebound-pay amount="${esc(amount)}" order="${esc(order)}"></sitebound-pay>${tail}`;
  return `${head}
  <p id="what"></p>
  <div id="slot"></div>${tail.replace('</script>\n</body>', () => `
  // Link form: ${esc(host)}/pay.html?amount=12.00&order=INV-1001
  var q = new URLSearchParams(location.search), a = q.get('amount') || '', o = q.get('order') || '';
  if (/^\\d{1,12}(\\.\\d{1,6})?$/.test(a) && Number(a) > 0 && /^[\\x20-\\x7e]{1,64}$/.test(o)) {
    document.getElementById('what').textContent = 'Order ' + o;
    var b = document.createElement('sitebound-pay');
    b.setAttribute('amount', a); b.setAttribute('order', o);
    document.getElementById('slot').append(b);
  } else {
    document.getElementById('what').textContent = 'This payment link is incomplete. Ask the seller for a new one.';
  }
</script>
</body>`)}`;
}

// The preview shows the real element but cannot be clicked: from here it would be a payment for our own domain.
const previewDoc = (amount, order) =>
`<!doctype html><html style="color-scheme:${document.documentElement.dataset.theme}"><style>body{margin:0;padding:20px;display:grid;justify-items:start}sitebound-pay{pointer-events:none;width:max-content}</style>
<script src="${BUTTON}"></script><sitebound-pay amount="${esc(amount)}" order="${esc(order)}"></sitebound-pay>`;

// ------------------------------------------------------------------ wiring
const show = (id, r) => {
  const el = $(id + '-msg');
  el.textContent = r.error ?? '';
  if (r.fix) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'link'; b.textContent = 'Use it';
    b.onclick = () => { $(id).value = r.fix; update(); $(id).focus(); };
    el.append(' ', b);
  }
  $(id).toggleAttribute('aria-invalid', !!r.error);
};

let last = '';
function update() {
  const s = checkSite($('site').value), a = checkAmount($('amount').value), o = checkOrder($('order').value);
  show('site', s); show('amount', a); show('order', o);
  const dyn = $('dyn').checked;
  $('dyn-note').hidden = !dyn;
  const ready = s.origin && a.amount && o.order;
  $('out').hidden = !ready;
  if (!ready) return;
  const v = { origin: s.origin, amount: a.amount, order: o.order, dyn };
  $('snippet').textContent = snippet(v.amount, v.order);
  $('page').textContent = pageHtml(v);
  $('where').textContent = `${s.origin}/pay.html`;
  const key = JSON.stringify(v);
  if (key !== last) { last = key; $('preview').srcdoc = previewDoc(v.amount, v.order); }
}

for (const id of ['site', 'amount', 'order']) $(id).addEventListener('input', update);
$('dyn').addEventListener('change', update);
$('form').addEventListener('submit', (e) => e.preventDefault());
document.querySelectorAll('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
  const text = $(btn.dataset.copy).textContent;
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
  catch { const r = document.createRange(); r.selectNodeContents($(btn.dataset.copy)); getSelection().removeAllRanges(); getSelection().addRange(r); btn.textContent = 'Press copy'; }
  setTimeout(() => (btn.textContent = 'Copy'), 1600);
}));

$('dl').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([$('page').textContent], { type: 'text/html' }));
  a.download = 'pay.html';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// Prefill from the link: /pay/?site=https://their.site&amount=12.00&order=INV-1001
$('site').value = q.get('site') ?? '';
$('amount').value = q.get('amount') ?? '';
$('order').value = q.get('order') ?? '';
update();

// Theme: index.html sets data-theme before first paint; the toggle flips it and remembers the choice.
const themeBtn = $('theme');
const syncTheme = () => {
  const dark = document.documentElement.dataset.theme === 'dark';
  themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#07080a' : '#fafaf7');
};
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('sitebound.theme', next); } catch { /* private mode */ }
  syncTheme();
  last = ''; update();
});
syncTheme();
