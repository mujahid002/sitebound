// Shared by the onboarding and dashboard pages: config, chain reads, wallet, formatting.
// Needs the vendored ethers UMD (global `ethers`) loaded before this module runs.
import { useState, useEffect, useCallback } from 'preact/hooks';

const { ethers } = window;
export const ZERO = ethers.ZeroAddress;

export const ABI = [
  'function sites(bytes32) view returns (address payout, address pendingPayout, uint64 activeAt, bool frozen, uint256 nonce)',
  'function payments(bytes32) view returns (address wallet, bytes32 siteHash, uint256 amount, uint256 refunded)',
  'function delay() view returns (uint64)',
  'function freeze(bytes32 siteHash)',
  'function unfreeze(bytes32 siteHash)',
  'function refund(bytes32 paymentId, uint256 amount)',
  'event Paid(bytes32 indexed paymentId, bytes32 indexed siteHash, string site, bytes32 orderId, address indexed wallet, address payout, uint256 amount)',
  'event Refunded(bytes32 indexed paymentId, address indexed wallet, uint256 amount)',
];
export const ERC20 = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];
export const iface = new ethers.Interface(ABI);

// ---------------------------------------------------------------- config

// config.js sets window.SITEBOUND = { chainId, rpcUrl, explorer, address, token, relayerUrl }.
// Dynamic import accepts it whether it is a plain script or a module.
export async function loadConfig() {
  let raw;
  try {
    const m = await import('../config.js');
    raw = window.SITEBOUND || m.default || m.SITEBOUND;
  } catch {
    return { error: 'missing' };
  }
  if (!raw || !raw.chainId || !raw.rpcUrl) return { error: 'invalid' };
  const trim = (s) => String(s || '').replace(/\/+$/, '');
  const cfg = {
    chainId: Number(raw.chainId),
    chainName: raw.chainName || 'Whitechain Sepolia',
    rpcUrl: raw.rpcUrl,
    explorer: trim(raw.explorer),
    address: raw.address || ZERO,
    token: raw.token || ZERO,
    relayerUrl: trim(raw.relayerUrl),
    frameOrigin: trim(raw.frameOrigin || raw.frameUrl),
  };
  cfg.configured = ethers.isAddress(cfg.address) && cfg.address.toLowerCase() !== ZERO;
  return { cfg };
}

// ---------------------------------------------------------------- site identity

// siteHash is keccak256 over the exact origin string, so anything that is not already
// an origin (path, trailing slash, uppercase host) would silently address another site.
export function parseSite(raw, { allowHttp = false } = {}) {
  if (!raw) return { error: 'none' };
  let u;
  try { u = new URL(raw); } catch { return { error: 'bad' }; }
  if (u.origin !== raw || u.origin === 'null') return { error: 'notorigin', hint: u.origin };
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return { error: 'https' };
  return { origin: raw, host: u.host, hostname: u.hostname, siteHash: ethers.keccak256(ethers.toUtf8Bytes(raw)) };
}

// ---------------------------------------------------------------- chain reads

let provider;
export function rpc(cfg) {
  if (!provider) {
    // staticNetwork: a dead RPC fails at once instead of retrying network detection forever.
    provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: ethers.Network.from(cfg.chainId) });
  }
  return provider;
}
export const reader = (cfg) => new ethers.Contract(cfg.address, ABI, rpc(cfg));

// 'none' when the address has no code (not deployed yet).
export async function contractState(cfg) {
  if (!cfg.configured) return 'none';
  const code = await rpc(cfg).getCode(cfg.address);
  return code === '0x' ? 'none' : 'ok';
}

// The contract promotes a pending payout lazily, the first time anyone touches the site.
// So the payout that counts is the pending one once chain time has passed activeAt.
export async function readSite(cfg, siteHash) {
  const [s, delay, block] = await Promise.all([reader(cfg).sites(siteHash), reader(cfg).delay(), rpc(cfg).getBlock('latest')]);
  const activeAt = Number(s.activeAt);
  const now = Number(block.timestamp);
  const promoted = s.pendingPayout !== ZERO && now >= activeAt;
  return {
    registered: s.payout !== ZERO,
    payout: promoted ? s.pendingPayout : s.payout,
    pending: s.pendingPayout !== ZERO && !promoted ? s.pendingPayout : null,
    activeAt,
    frozen: s.frozen,
    delay: Number(delay),
    chainNow: now,
    readAt: Date.now(),
  };
}
// Seconds until the pending payout goes live, using chain time advanced by the local clock.
export const secondsLeft = (info) => Math.max(0, info.activeAt - (info.chainNow + (Date.now() - info.readAt) / 1000));

// ---------------------------------------------------------------- wallet

export async function ensureChain(cfg) {
  const eth = window.ethereum;
  const hex = '0x' + cfg.chainId.toString(16);
  if (parseInt(await eth.request({ method: 'eth_chainId' }), 16) === cfg.chainId) return;
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    const code = e?.code ?? e?.data?.originalError?.code;
    if (code !== 4902 && code !== -32603) throw e;
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hex,
        chainName: cfg.chainName,
        nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
        rpcUrls: [cfg.rpcUrl],
        blockExplorerUrls: cfg.explorer ? [cfg.explorer] : [],
      }],
    });
  }
}

const norm = (a) => (a ? ethers.getAddress(a) : null);

function useInjectedWallet(cfg) {
  const eth = window.ethereum;
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [restored, setRestored] = useState(!eth); // true once an already-connected wallet has been looked for

  useEffect(() => {
    if (!eth) return;
    const onAccounts = (a) => setAccount(norm(a?.[0]));
    const onChain = (id) => setChainId(parseInt(id, 16));
    // Restore a wallet the user already connected here, without a prompt.
    eth.request({ method: 'eth_accounts' }).then(onAccounts).catch(() => {}).finally(() => setRestored(true));
    eth.request({ method: 'eth_chainId' }).then(onChain).catch(() => {});
    eth.on?.('accountsChanged', onAccounts);
    eth.on?.('chainChanged', onChain);
    return () => {
      eth.removeListener?.('accountsChanged', onAccounts);
      eth.removeListener?.('chainChanged', onChain);
    };
  }, []);

  const connect = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const a = await eth.request({ method: 'eth_requestAccounts' });
      setAccount(norm(a?.[0]));
      await ensureChain(cfg);
      setChainId(parseInt(await eth.request({ method: 'eth_chainId' }), 16));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, [cfg]);

  // Fresh BrowserProvider each time: the chain may have changed since the last call.
  const getSigner = useCallback(async () => {
    await ensureChain(cfg);
    return new ethers.BrowserProvider(eth, 'any').getSigner();
  }, [cfg]);

  return { kind: 'injected', hasWallet: !!eth, restored, account, chainId, onChain: chainId === cfg.chainId, busy, error, connect, getSigner };
}

// A payout wallet Sitebound creates for an owner who has none. The key stays in this browser: the recovery phrase
// is stored in localStorage and goes nowhere else. Every hook instance (setup, dashboard chip, refund dialog) shares
// it through this tiny store, so creating it in one place shows up in the rest. "Use my own wallet" is a separate
// flag: it only hides this wallet (the key stays stored), so choosing it never deletes anything.
const LOCAL_KEY = 'sitebound.payoutWallet.v1';
const OWN_KEY = 'sitebound.useOwnWallet.v1';
const local = { wallet: null, own: false, kept: true, loaded: false, subs: new Set() };
const active = () => (local.own ? null : local.wallet);

function loadLocal() {
  if (local.loaded) return local.wallet;
  local.loaded = true;
  try { local.own = localStorage.getItem(OWN_KEY) === '1'; } catch { /* no storage */ }
  try {
    const o = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
    const w = o?.phrase ? ethers.Wallet.fromPhrase(o.phrase) : null;
    if (w && w.address === o.address) local.wallet = w;
  } catch { /* no storage, or a stored value that is not ours */ }
  return local.wallet;
}

export const newLocalWallet = () => ethers.Wallet.createRandom();
export const ownWalletChosen = () => { loadLocal(); return local.own; };

// true: work with the browser's own wallet instead of the one made here. false: back to the one made here.
export function useOwnWallet(on) {
  loadLocal();
  local.own = on;
  try { on ? localStorage.setItem(OWN_KEY, '1') : localStorage.removeItem(OWN_KEY); } catch { /* no storage */ }
  local.subs.forEach((f) => f());
}

// Keeps the wallet for the next visit. Returns false when the browser would not store it (the wallet still
// works until the page closes, and the backup is the only copy).
export function saveLocalWallet(w) {
  let stored = true;
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ v: 1, address: w.address, phrase: w.mnemonic.phrase })); } catch { stored = false; }
  local.loaded = true;
  local.wallet = w;
  local.kept = stored;
  local.subs.forEach((f) => f());
  return stored;
}

export function backupText(w, cfg) {
  return ['Sitebound payout wallet backup', '',
    `Address: ${w.address}`, `Network: ${cfg.chainName}`, '',
    'Recovery phrase (12 words, in this order):', w.mnemonic.phrase, '',
    'Anyone who has this phrase controls the money in this wallet. Keep it private.',
    'Sitebound cannot recover it. Import it into any Ethereum wallet app to use the wallet.', ''].join('\n');
}

function useLocalWallet(cfg) {
  const [w, setW] = useState(() => { loadLocal(); return active(); });
  useEffect(() => {
    const f = () => setW(active());
    local.subs.add(f);
    f();
    return () => local.subs.delete(f);
  }, []);
  if (!w) return null;
  // Same shape as the injected wallet. It signs with its own key, so there is no prompt, but it has to hold WBT for gas.
  return {
    kind: 'local', localWallet: w, kept: local.kept, hasWallet: true, account: w.address, chainId: cfg.chainId, onChain: true, busy: false, error: '',
    connect: async () => {},
    getSigner: async () => w.connect(rpc(cfg)),
  };
}

// The wallet the page works with: the one Sitebound created if there is one, else the browser's own wallet.
export function useWallet(cfg) {
  const injected = useInjectedWallet(cfg);
  return useLocalWallet(cfg) || injected;
}

// ---------------------------------------------------------------- text helpers

const REVERTS = [
  ['not payout', 'This wallet is not the current payout wallet for the site.'],
  ['over refund', 'That is more than is left to refund on this payment.'],
  ['frozen', 'The site is frozen. The payout wallet has to unfreeze it first.'],
  ['no such payment', 'The contract has no payment with that id.'],
  ['insufficient funds', 'Not enough WBT in this wallet to pay for gas. Send a little WBT to it, then try again.'],
  ['exceeds balance', 'Not enough USDT in this wallet.'],
];
// Error text safe to show: no URLs (a provider error can carry a keyed RPC URL), short.
export function errText(e) {
  if (e?.code === 'ACTION_REJECTED' || e?.code === 4001) return 'You cancelled the request in your wallet.';
  const raw = String(e?.reason || e?.shortMessage || e?.message || e || 'Something went wrong.');
  const low = raw.toLowerCase();
  for (const [k, v] of REVERTS) if (low.includes(k)) return v;
  return raw.replace(/https?:\/\/[^\s"')\]]+/gi, '[url]').replace(/\s+/g, ' ').slice(0, 180);
}

// Failed chain reads: ethers' own wording ("could not coalesce error") means nothing to a shop owner.
export const readText = () => 'The network node did not answer. Check your connection and try again.';

export const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
export const sameAddr = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

const group = (n) => BigInt(n).toLocaleString('en-US');
// 6-decimal USDT amount: at least two decimals, trailing zeros beyond that dropped.
export function fmtUsdt(v) {
  const [i, f = ''] = ethers.formatUnits(v, 6).split('.');
  const d = f.replace(/0+$/, '');
  return group(i) + '.' + (d.length < 2 ? d.padEnd(2, '0') : d);
}
export function parseUsdt(s) {
  const t = String(s).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  return ethers.parseUnits(t, 6);
}

// bytes32 order id -> text when it is printable ASCII padded with zeros, else null.
export function orderText(hex) {
  const b = ethers.getBytes(hex);
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  if (end === 0) return null;
  for (let i = 0; i < end; i++) if (b[i] < 0x20 || b[i] > 0x7e) return null;
  return new TextDecoder().decode(b.slice(0, end));
}

export function duration(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}
// Words for a delay shown before a click: "1 hour", "15 minutes".
export function durationWords(sec) {
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (sec >= 86400 && sec % 86400 === 0) return unit(sec / 86400, 'day');
  if (sec >= 3600 && sec % 3600 === 0) return unit(sec / 3600, 'hour');
  if (sec >= 60) return unit(Math.round(sec / 60), 'minute');
  return unit(sec, 'second');
}

export const txUrl = (cfg, h) => (cfg.explorer ? `${cfg.explorer}/tx/${h}` : '');
export const addrUrl = (cfg, a) => (cfg.explorer ? `${cfg.explorer}/address/${a}` : '');

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;opacity:0';
    document.body.append(t); t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  }
}
