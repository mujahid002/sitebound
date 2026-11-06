// Landing: the search bar with websites orbiting it, the lit dot field behind the page, and the setup kit that
// opens inline. The kit (Preact + ethers) loads only when someone brings a website, so the first paint stays light.
import { mountOrbit } from './orbit.js';
import { mountField } from './field.js';

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

// The orbit's data: { domain, label, kind } and nothing else to edit. kind 'real' is a business that shows a deposit
// address to copy today (checked 7 Nov 2026, listed in the notes for the page, not an endorsement and not a Sitebound
// customer); 'ours' is a Sitebound example. `origin` is only needed when it is not https://<domain> (the local demo).
// Each chip loads https://<domain>/favicon.ico; `logo` names a different icon URL where that one does not work.
const SITES = [
  C.demoShop && { domain: hostOf(C.demoShop), origin: C.demoShop, label: 'the Sitebound demo', kind: 'ours' },
  { domain: '0xmujahid.xyz', label: '0xmujahid.xyz', kind: 'ours' },
  { domain: 'surfercloud.com', label: 'SurferCloud', kind: 'real', logo: 'https://cdn.udelivrs.com/2024/06/45a0684f8481db470c2dfcf60b7a7356_1718953536546.ico' },
  { domain: 'protonvpn.com', label: 'Proton VPN', kind: 'real' },
  { domain: 'cloudzy.com', label: 'Cloudzy', kind: 'real', logo: 'https://cloudzy.com/apple-touch-icon.png' },
  { domain: 'bitrefill.com', label: 'Bitrefill', kind: 'real' },
  { domain: 'bitlaunch.io', label: 'BitLaunch', kind: 'real' },
].filter(Boolean);
// Sites the visitor typed join the orbit for this visit only; nothing is stored, so no old entry can come back.
try { localStorage.removeItem('sitebound.ring'); } catch { /* private mode */ }
let typed = [];
const ringSites = () => [
  ...SITES.filter((b) => b.kind === 'ours'),
  ...typed.filter((o) => !SITES.some((b) => (b.origin || `https://${b.domain}`) === o)).reverse().map((o) => ({ origin: o, domain: hostOf(o), label: hostOf(o), kind: 'user' })),
  ...SITES.filter((b) => b.kind !== 'ours'),
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
  onPick: (origin) => open(origin),
  around: $('search-row'),
  keepClear: [...document.querySelectorAll('.hero-h, .tagline, #search-row, .trust, .hero-links > *, .orbit-key')],
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

async function open(origin, { scroll = true } = {}) {
  show('');
  state('loading');
  input.value = hostOf(origin);
  addToRing(origin);
  orbit.highlight(origin);
  history.replaceState(null, '', '?site=' + encodeURIComponent(origin) + '#kit');
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

// "Bring your website" at the bottom scrolls up and lands the cursor in the search box.
document.querySelector('[data-focus-search]').addEventListener('click', (e) => {
  e.preventDefault();
  input.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' });
  input.focus({ preventScroll: true });
});

const demoLink = document.querySelector('[data-demo-link]');
if (demoLink && C.demoShop) demoLink.href = C.demoShop + '/';

// A shared link (?site=https://example.com) opens straight into that site's kit.
const shared = new URLSearchParams(location.search).get('site');
if (shared) {
  const { origin } = toOrigin(shared);
  if (origin) open(origin, { scroll: false }).then(() => kitSection.scrollIntoView({ block: 'start' }));
}

// ---------------------------------------------------------------- verify us

const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '') && !/^0x0{40}$/.test(a);
if (isAddr(C.address)) {
  for (const el of document.querySelectorAll('[data-cfg-address]')) el.textContent = C.address;
  if (C.explorer) for (const el of document.querySelectorAll('[data-cfg-explorer]')) el.href = `${C.explorer}/address/${C.address}`;
}
if (C.relayerFee) for (const el of document.querySelectorAll('[data-cfg-fee]')) el.textContent = C.relayerFee;

const copyBtn = document.querySelector('[data-copy-address]');
copyBtn?.addEventListener('click', async () => {
  const text = document.querySelector('.vaddr code').textContent;
  try { await navigator.clipboard.writeText(text); copyBtn.textContent = 'Copied'; } catch { copyBtn.textContent = 'Select the address to copy'; }
  setTimeout(() => { copyBtn.textContent = 'Copy address'; }, 1800);
});

async function rpcCall(method, params) {
  const r = await fetch(C.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error('rpc'); // the message is not shown: it could carry a provider URL
  return j.result;
}

const words = (sec) => {
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (sec >= 86400 && sec % 86400 === 0) return unit(sec / 86400, 'day');
  if (sec >= 3600 && sec % 3600 === 0) return unit(sec / 3600, 'hour');
  return sec >= 60 ? unit(Math.round(sec / 60), 'minute') : unit(sec, 'second');
};

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
    if (exp?.commit && /^[0-9a-f]{7,40}$/i.test(exp.commit)) {
      const a = Object.assign(document.createElement('a'), {
        href: `https://github.com/mujahid002/sitebound/commit/${exp.commit}`, target: '_blank', rel: 'noopener', textContent: exp.commit.slice(0, 12),
      });
      $('vc-commit').replaceChildren(a);
    }
    if (exp?.solc) {
      const runs = exp.optimizer?.enabled ? exp.optimizer.runs : exp.optimizerRuns;
      set('vc-solc', [`solc ${exp.solc}`, exp.viaIR ? 'via_ir' : null, runs ? `optimizer ${runs} runs` : null,
        exp.evmVersion ? `EVM ${exp.evmVersion}` : null].filter(Boolean).join(', '));
    }
    if (exp?.sourcify?.match && /^https:\/\/sourcify\.dev\//.test(exp.sourcify.url || '')) {
      const a = Object.assign(document.createElement('a'), { href: exp.sourcify.url, target: '_blank', rel: 'noopener', textContent: `Sourcify: ${exp.sourcify.match.replace(/_/g, ' ')}` });
      $('vc-sourcify').replaceChildren(a);
      $('vc-sourcify-row').hidden = false;
    }
    rpcCall('eth_call', [{ to: C.address, data: ethers.id('delay()').slice(0, 10) }, 'latest'])
      .then((d) => { for (const el of document.querySelectorAll('[data-delay]')) el.textContent = words(Number(BigInt(d))); })
      .catch(() => {});
    if (!code || code === '0x') { set('vc-live', 'no code'); return mark('bad', 'Mismatch: there is no contract code at this address.'); }
    const want = exp && /^0x[0-9a-fA-F]{64}$/.test(exp.runtimeCodeHashMasked || '') ? exp.runtimeCodeHashMasked : null;
    if (!want) { set('vc-live', ethers.keccak256(code)); set('vc-exp', 'not published yet'); return mark('warn', 'The expected hash is not published yet, so there is nothing to compare with.'); }
    if (exp.address && exp.address.toLowerCase() !== C.address.toLowerCase()) return mark('bad', 'Mismatch: verify/expected.json describes a different contract address.');
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
    if (off.length) return mark('bad', `Mismatch: the deployed ${off.join(', ')} ${off.length === 1 ? 'differs' : 'differ'} from the repo's file.`);
    if (live.toLowerCase() === want.toLowerCase()) mark('ok', 'Match: the code on chain is the code the repo says it is.');
    else mark('bad', 'Mismatch: the code on chain differs from the repo\'s expected hash.');
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
