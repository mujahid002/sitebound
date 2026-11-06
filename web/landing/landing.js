// Sitebound landing: turn what the shop owner typed into an https origin, then hand off to onboarding.
const form = document.getElementById('site-form');
const input = document.getElementById('site');
const msg = document.getElementById('site-msg');

const HOST = /^([a-z0-9-]+\.)+[a-z][a-z0-9-]+$/; // needs a dot and an alphabetic TLD (punycode ok)

// Returns { origin } or { error }.
function toOrigin(raw) {
  let s = raw.replace(/\s+/g, '').toLowerCase();
  if (!s) return { error: 'Type your website first, for example shop.com.' };
  if (s.startsWith('http://')) return { error: 'Sitebound needs https. Use shop.com or https://shop.com.' };
  s = s.replace(/^https:\/\//, '');
  const host = s.split(/[/?#]/)[0];
  if (host.includes('@') || host.includes('://')) return { error: 'Use just the site name, like shop.com.' };
  let url;
  try { url = new URL('https://' + host); } catch { url = null; }
  if (!url || !HOST.test(url.hostname)) return { error: 'That does not look like a website. Try shop.com.' };
  return { origin: url.origin };
}

function show(text) {
  msg.textContent = text;
  if (text) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const { origin, error } = toOrigin(input.value);
  if (error) { show(error); input.focus(); return; }
  show('');
  location.href = '../onboard/index.html?site=' + encodeURIComponent(origin);
});

input.addEventListener('input', () => show(''));

// "Connect my shop" at the bottom scrolls up and lands the cursor in the search bar.
document.querySelector('[data-focus-search]').addEventListener('click', (e) => {
  e.preventDefault();
  input.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  input.focus({ preventScroll: true });
});
