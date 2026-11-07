// Wallet chooser for the top-level popups (setup.html, send.html). Dependency-free EIP-6963 discovery:
// every injected wallet announces itself, so MetaMask, Coinbase Wallet, Rabby, Phantom ... are all listed
// instead of whichever one won window.ethereum. Not included: WalletConnect (mobile QR), which needs a Reown project id.
// pickWallet({ chainId, chainName, title }) -> Promise<{ provider, info, accounts }>. It rejects with
// { code: 'CANCELLED' } when the dialog is closed without a wallet. Needs wallet-picker.css on the page.

const STORE = 'sitebound.wallet'; // last chosen info.rdns: only used to sort that wallet first
const WAIT_MS = 400; // how long a first look waits for announcements before it falls back
const INSTALL = [['MetaMask', 'https://metamask.io/download'], ['Coinbase Wallet', 'https://www.coinbase.com/wallet']];

const announced = new Map(); // rdns (or uuid) -> { key, info, provider }
const listeners = new Set();
let listening = false;
let firstLookAt = 0;
let open = null; // the dialog that is showing, so a second call joins it

function onAnnounce(ev) {
  const { info, provider } = ev.detail ?? {};
  if (!info || typeof provider?.request !== 'function') return;
  const key = String(info.rdns || info.uuid || info.name);
  announced.set(key, { key, info: { ...info, name: String(info.name || 'Wallet') }, provider });
  listeners.forEach((f) => f());
}

function discover() {
  if (!listening) {
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    listening = true;
  }
  if (!firstLookAt) firstLookAt = Date.now();
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

// Wallets that never announce. Flag names are best effort (some wallets copy isMetaMask), hence the neutral default.
function legacyName(p) {
  if (p.isCoinbaseWallet) return 'Coinbase Wallet';
  if (p.isRabby) return 'Rabby';
  if (p.isPhantom) return 'Phantom';
  if (p.isMetaMask) return 'MetaMask';
  return 'Browser wallet';
}

function fallback() {
  const eth = window.ethereum;
  if (!eth || typeof eth.request !== 'function') return [];
  const list = Array.isArray(eth.providers) && eth.providers.length ? eth.providers : [eth];
  return list.filter((p) => typeof p?.request === 'function').map((p, i) => ({
    key: `window.ethereum${list.length > 1 ? `#${i}` : ''}`,
    info: { name: list.length > 1 ? legacyName(p) : 'Browser wallet', icon: '', rdns: '' },
    provider: p,
  }));
}

const lastUsed = () => { try { return localStorage.getItem(STORE) || ''; } catch { return ''; } };
const remember = (rdns) => { try { if (rdns) localStorage.setItem(STORE, rdns); } catch { /* storage can be blocked */ } };

function h(tag, props = {}, ...kids) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids.filter((k) => k != null));
  return el;
}

export function pickWallet({ chainId, chainName, title = 'Choose a wallet' } = {}) {
  if (open) return open.promise;

  const root = h('div', { className: 'wp-root' });
  const dialog = h('div', { className: 'wp-dialog', role: 'dialog', tabIndex: -1 });
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'wp-title');
  const closeBtn = h('button', { className: 'wp-close', type: 'button', textContent: '×' });
  closeBtn.setAttribute('aria-label', 'Close');
  const sub = h('p', { className: 'wp-sub', id: 'wp-sub', textContent: chainName ? `Pay on ${chainName}${chainId ? ` (${chainId})` : ''}. The wallet asks before anything is sent.` : 'The wallet asks before anything is sent.' });
  dialog.setAttribute('aria-describedby', 'wp-sub');
  const list = h('ul', { className: 'wp-list' });
  const status = h('p', { className: 'wp-status', role: 'status' });
  status.setAttribute('aria-live', 'polite');
  const none = h('div', { className: 'wp-none' });
  dialog.append(
    h('div', { className: 'wp-head' }, h('h2', { id: 'wp-title', className: 'wp-title', textContent: title }), closeBtn),
    sub, list, none, status,
  );
  root.append(dialog);

  const returnTo = document.activeElement;
  const inerted = [...document.body.children].filter((el) => !el.hasAttribute('inert')); // the page behind is not reachable
  inerted.forEach((el) => el.setAttribute('inert', ''));
  document.body.append(root);

  let busy = false;
  let settled = false;
  let shownKeys = '';
  let waiting = Date.now() - firstLookAt < WAIT_MS || !firstLookAt;
  let timer = null;

  const entries = () => {
    const all = [...announced.values()];
    const found = all.length || waiting ? all : fallback();
    const last = lastUsed();
    return found.sort((a, b) => (b.info.rdns === last && last ? 1 : 0) - (a.info.rdns === last && last ? 1 : 0));
  };

  function render() {
    if (busy) return;
    const items = entries();
    const sig = `${waiting}|${items.map((e) => e.key).join(',')}`;
    if (sig === shownKeys) return;
    shownKeys = sig;
    const focusedKey = document.activeElement?.dataset?.key;
    list.replaceChildren();
    none.replaceChildren();
    list.hidden = !items.length;
    none.hidden = !!items.length || waiting;
    if (!items.length && waiting) {
      status.className = 'wp-status wp-spin';
      status.textContent = 'Looking for wallets…';
    } else if (!items.length) {
      status.className = 'wp-status';
      status.textContent = '';
      none.append(
        h('p', { className: 'wp-nowallet', textContent: 'No wallet found' }),
        h('p', { className: 'wp-sub', textContent: 'Install a browser wallet, then reload this page.' }),
        h('div', { className: 'wp-install' }, ...INSTALL.map(([name, href]) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', textContent: `Get ${name}` }))),
        h('button', { className: 'wp-reload', type: 'button', textContent: 'Reload', onclick: () => location.reload() }),
      );
    } else if (status.classList.contains('wp-spin') && !busy) {
      status.className = 'wp-status';
      status.textContent = '';
    }
    const last = lastUsed();
    for (const e of items) {
      const icon = /^data:image\//i.test(e.info.icon || '')
        ? h('img', { className: 'wp-icon', src: e.info.icon, alt: '', width: 32, height: 32 })
        : h('span', { className: 'wp-icon wp-letter', textContent: e.info.name.slice(0, 1).toUpperCase() });
      const btn = h('button', { className: 'wp-wallet', type: 'button' }, icon, h('span', { className: 'wp-name', textContent: e.info.name }),
        e.info.rdns && e.info.rdns === last ? h('span', { className: 'wp-tag', textContent: 'Last used' }) : null);
      btn.dataset.key = e.key;
      btn.onclick = () => choose(e, btn);
      list.append(h('li', {}, btn));
    }
    if (focusedKey) list.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus();
  }

  function finish(fn) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    listeners.delete(render);
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    inerted.forEach((el) => el.removeAttribute('inert'));
    open = null;
    returnTo?.focus?.();
    fn();
  }

  async function choose(e, btn) {
    if (busy) return;
    busy = true;
    list.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    btn.classList.add('wp-busy');
    status.className = 'wp-status wp-spin';
    status.textContent = `Check ${e.info.name} to continue…`;
    try {
      const accounts = await e.provider.request({ method: 'eth_requestAccounts' });
      if (!accounts?.length) throw new Error(`${e.info.name} returned no account.`);
      remember(e.info.rdns);
      finish(() => resolve({ provider: e.provider, info: e.info, accounts }));
    } catch (err) {
      if (settled) return;
      busy = false;
      list.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      btn.classList.remove('wp-busy');
      status.className = 'wp-status wp-err';
      status.textContent = err?.code === 4001 ? 'You closed the wallet request.'
        : err?.code === -32002 ? `Open ${e.info.name}: a request is already waiting there.`
        : String(err?.shortMessage || err?.message || 'The wallet did not connect.').replace(/\bhttps?:\/\/\S+/g, '[url]').slice(0, 160);
      shownKeys = '';
      render();
      btn.focus();
    }
  }

  const cancel = () => finish(() => reject(Object.assign(new Error('Wallet selection was closed.'), { code: 'CANCELLED' })));

  function onKey(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancel(); return; }
    if (ev.key !== 'Tab') return;
    const f = [...dialog.querySelectorAll('button:not(:disabled), a[href]')].filter((el) => !el.closest('[hidden]'));
    if (!f.length) { ev.preventDefault(); dialog.focus(); return; }
    const i = f.indexOf(document.activeElement);
    if (ev.shiftKey && (i <= 0)) { ev.preventDefault(); f[f.length - 1].focus(); }
    else if (!ev.shiftKey && (i === -1 || i === f.length - 1)) { ev.preventDefault(); f[0].focus(); }
  }

  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {}); // a caller that ignores a cancel must not log an unhandled rejection
  open = { promise };

  closeBtn.onclick = cancel;
  root.addEventListener('mousedown', (ev) => { if (ev.target === root) cancel(); });
  document.addEventListener('keydown', onKey, true);
  listeners.add(render);

  discover();
  render();
  (list.querySelector('button') || dialog).focus();
  if (waiting) {
    timer = setTimeout(() => {
      waiting = false;
      const hadFocus = dialog.contains(document.activeElement) && document.activeElement !== dialog;
      render();
      if (!hadFocus) (list.querySelector('button') || dialog).focus();
    }, Math.max(0, WAIT_MS - (Date.now() - firstLookAt)));
  }
  return promise;
}
