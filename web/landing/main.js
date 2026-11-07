// Landing: the search bar with websites orbiting it, the lit dot field behind the page, and the setup kit that
// opens inline. The kit (Preact + ethers) loads only when someone brings a website, so the first paint stays light.
import { mountOrbit } from './orbit.js';
import { mountField } from './field.js';
import { mountPanel } from './panel.js';
import { SITES } from './sites.js';

const C = window.SITEBOUND || {};
const $ = (id) => document.getElementById(id);
const form = $('site-form');
const input = $('site');
const msg = $('site-msg');
const row = $('search-row');
const kitSection = $('kit');
const kitRoot = $('kit-root');
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const HOST = /^([a-z0-9-]+\.)+[a-z][a-z0-9-]+$/; // needs a dot and an alphabetic TLD (punycode ok)

// What the site owner typed -> { origin } or { error }.
function toOrigin(raw) {
  let s = raw.replace(/\s+/g, '').toLowerCase();
  if (!s) return { error: 'Type your website first, for example example.com.' };
  if (s.startsWith('http://')) return { error: 'Sitebound needs https. Use example.com or https://example.com.' };
  s = s.replace(/^https:\/\//, '');
  const host = s.split(/[/?#]/)[0];
  if (host.includes('@') || host.includes('://')) return { error: 'Use just the site name, like example.com.' };
  let url;
  try { url = new URL('https://' + host); } catch { url = null; }
  if (!url || !HOST.test(url.hostname)) return { error: 'That does not look like a website. Try example.com.' };
  return { origin: url.origin };
}

// The bar's state, for CSS: '' (idle), 'valid' (the text reads as a website), 'loading' (the setup is opening).
const state = (s) => { row.dataset.state = s; };

function show(text) {
  msg.textContent = text;
  if (text) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

const hostOf = (o) => { try { return new URL(o).host; } catch { return o; } };

// ---------------------------------------------------------------- the orbit

// The orbit is drawn from SITES (sites.js). A 'real' chip opens the detail panel; 'ours' chips and the sites a visitor
// types open the setup for that site. Sites the visitor typed join the orbit for this visit only; nothing is stored,
// so no old entry can come back.
try { localStorage.removeItem('sitebound.ring'); } catch { /* private mode */ }
let typed = [];
const ringSites = () => [
  ...SITES.filter((b) => b.kind === 'ours'),
  ...typed.filter((o) => !SITES.some((b) => (b.origin || `https://${b.domain}`) === o)).reverse().map((o) => ({ origin: o, domain: hostOf(o), kind: 'user' })),
  // Businesses that are not Sitebound sites (kind 'real') are not drawn: only sites that use it, and the ones a visitor types.
];

// Theme: index.html sets data-theme before first paint; the toggle flips it and remembers the choice.
const themeBtn = $('theme');
function paintTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#07080a' : '#fafaf7');
}
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('sitebound.theme', next); } catch { /* private mode */ }
  paintTheme();
});
paintTheme();

mountField($('field'));
const orbit = mountOrbit($('orbit'), {
  sites: ringSites(),
  onPick: (site, chip) => (site.kind === 'real' ? panel.openSite(site, chip) : open(site.origin || `https://${site.domain}`)),
  around: $('search-row'),
  keepClear: [...document.querySelectorAll('.hero-h, .tagline, #search-row, .trust, .hero-links > *')],
});
const panel = mountPanel($('panel'), {
  hero: document.querySelector('.hero'),
  onToggle: (isOpen, site) => { orbit.setSlow(isOpen); orbit.highlight(site ? `https://${site.domain}` : null); },
});

function addToRing(origin) {
  if (SITES.some((b) => (b.origin || `https://${b.domain}`) === origin) || typed.includes(origin)) return;
  typed = [...typed, origin].slice(-6);
  orbit.setSites(ringSites());
}

// ---------------------------------------------------------------- the kit

let ethersLoad;
function loadEthers() {
  if (window.ethers) return Promise.resolve();
  ethersLoad ||= new Promise((ok, fail) => {
    const s = Object.assign(document.createElement('script'), { src: '../vendor/ethers-6.17.0.umd.min.js', onload: ok, onerror: fail });
    document.head.append(s);
  });
  ethersLoad.catch(() => { ethersLoad = null; });
  return ethersLoad;
}

let kitModule;
function loadKit() {
  kitModule ||= loadEthers().then(() => import('./kit.js'));
  kitModule.catch(() => { kitModule = null; });
  return kitModule;
}

// The setup is its own page, so Back returns to this one. https sites get the short ?site=host form.
const setupUrl = (origin) => '../onboard/?site=' + (origin.startsWith('https://') ? hostOf(origin) : encodeURIComponent(origin));
function open(origin, { replace = false } = {}) {
  replace ? location.replace(setupUrl(origin)) : location.assign(setupUrl(origin));
}
async function openInline(origin, { scroll = true } = {}) {
  panel.close({ restore: false });
  show('');
  state('loading');
  input.value = hostOf(origin);
  addToRing(origin);
  orbit.highlight(origin);
  history.replaceState(null, '', '?site=' + hostOf(origin));
  kitSection.hidden = false;
  kitSection.setAttribute('aria-busy', 'true');
  if (!kitRoot.firstChild) kitRoot.innerHTML = '<p class="lede kit-loading" role="status">Loading your site setup…</p>';
  if (scroll) kitSection.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
  try {
    const { openKit } = await loadKit();
    openKit(kitRoot, origin, { onChange: reset });
  } catch {
    kitRoot.innerHTML = '<p class="lede" role="alert">The setup could not load. Check your connection, then try again.</p>';
  }
  kitSection.removeAttribute('aria-busy');
  state('valid');
}

function reset() {
  history.replaceState(null, '', location.pathname);
  orbit.highlight(null);
  state('');
  input.select();
  input.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const { origin, error } = toOrigin(input.value);
  if (error) { show(error); input.focus(); return; }
  open(origin);
});
input.addEventListener('input', () => { show(''); state(toOrigin(input.value).origin ? 'valid' : ''); });
// Warm the kit while the owner is still typing.
input.addEventListener('focus', () => { loadKit().catch(() => {}); }, { once: true });

const demoLink = document.querySelector('[data-demo-link]');
if (demoLink && C.demoShop) demoLink.href = C.demoShop + '/';

// A shared link (?site=https://example.com) opens straight into that site's kit.
const shared = new URLSearchParams(location.search).get('site');
if (shared) {
  const { origin } = toOrigin(shared);
  if (origin) open(origin, { replace: true });
}

// ---------------------------------------------------------------- verify us

const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '') && !/^0x0{40}$/.test(a);

async function rpcCall(method, params) {
  const r = await fetch(C.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error('rpc'); // the message is not shown: it could carry a provider URL
  return j.result;
}

// Reads the contract's runtime code from the RPC in config.js, hashes it here and compares it with verify/expected.json.
async function runCheck() {
  const res = $('vc-result');
  const set = (id, text) => { $(id).textContent = text; };
  const chip = $('vc-chip');
  const CHIP = { '': 'Checking', ok: 'Match', warn: 'Not verified', bad: 'Mismatch' };
  const mark = (kind, text) => {
    res.className = 'vresult ' + kind; res.textContent = text;
    chip.className = 'chip ' + kind; chip.textContent = CHIP[kind];
  };
  if (!C.rpcUrl || !isAddr(C.address)) return mark('warn', 'This build has no contract address in its config, so there is nothing to check.');
  try { set('vc-rpc', new URL(C.rpcUrl).host); } catch { /* keep the default text */ }
  mark('', 'Checking…');
  try {
    const [exp, code] = await Promise.all([
      fetch('../verify/expected.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      rpcCall('eth_getCode', [C.address, 'latest']),
      loadEthers(),
    ]);
    const { ethers } = window;
    if (!code || code === '0x') { set('vc-live', 'no code'); return mark('bad', 'Mismatch: there is no contract code at this address.'); }
    const want = exp && /^0x[0-9a-fA-F]{64}$/.test(exp.runtimeCodeHashMasked || '') ? exp.runtimeCodeHashMasked : null;
    if (!want) { set('vc-live', ethers.keccak256(code)); set('vc-exp', 'not published yet'); return mark('warn', 'The expected hash is not published yet, so there is nothing to compare with.'); }
    if (exp.address && exp.address.toLowerCase() !== C.address.toLowerCase()) return mark('bad', 'Mismatch: the published file describes a different contract address.');
    // Recipe from expected.json: zero every immutable's byte ranges, then keccak256. Before zeroing, check each
    // immutable holds the value the file lists (the token, the RP ID hash, the payout delay).
    const bytes = ethers.getBytes(code);
    const wrong = [];
    for (const [name, im] of Object.entries(exp.immutables || {})) {
      for (const off of im.offsets || []) {
        const at = bytes.slice(off, off + im.length);
        if (at.length !== im.length || (im.value != null && BigInt(ethers.hexlify(at)) !== BigInt(im.value))) wrong.push(name);
        bytes.fill(0, off, off + im.length);
      }
    }
    const live = ethers.keccak256(bytes);
    set('vc-live', live);
    set('vc-len', `${bytes.length} bytes${exp.runtimeCodeLength ? ` (listed: ${exp.runtimeCodeLength})` : ''}`);
    set('vc-exp', want);
    const names = Object.keys(exp.immutables || {});
    set('vc-imm', names.length ? (wrong.length ? `differ: ${[...new Set(wrong)].join(', ')}` : `${names.join(', ')}: as listed`) : 'none listed');
    const off = [...new Set(wrong)];
    if (off.length) return mark('bad', `Mismatch: the deployed ${off.join(', ')} ${off.length === 1 ? 'differs' : 'differ'} from the published file.`);
    if (live.toLowerCase() === want.toLowerCase()) mark('ok', 'Match: the code on chain is the published code.');
    else mark('bad', 'Mismatch: the code on chain differs from the published hash.');
  } catch {
    mark('warn', 'Could not reach the network to check. Reload to try again.');
  }
}

// Scroll reveal and the drawn connectors: one observer. [data-reveal] fades up (200 to 300 ms, CSS), [data-flow] draws
// its connectors. Both get .is-in once. Reduced motion: nothing is hidden, so nothing needs revealing. The hidden start
// state exists only after this script runs (.reveal-ready), so the page stays readable if it never does.
const reveal = !reduced() && 'IntersectionObserver' in window;
if (reveal) {
  document.documentElement.classList.add('reveal-ready');
  for (const group of new Set([...document.querySelectorAll('[data-reveal]')].map((el) => el.parentElement))) {
    [...group.children].filter((el) => el.hasAttribute('data-reveal')).forEach((el, i) => el.style.setProperty('--i', i));
  }
}
const flows = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-in'); flows.unobserve(e.target); }
}, { rootMargin: '0px 0px -8% 0px' });
for (const el of document.querySelectorAll('[data-flow], [data-reveal]')) flows.observe(el);

const verifySection = $('verify');
if (verifySection) {
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { io.disconnect(); runCheck(); }
  }, { rootMargin: '300px' });
  io.observe(verifySection);
}
