// Payment receipt: one Sitebound payment, read from the contract and its Paid / Refunded events.
// /receipt/?id=<paymentId>  or  /receipt/?tx=<transaction hash>
import { render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { html } from '../onboard/ui.js';
import { iface, ZERO, loadConfig, rpc, reader, readText, fmtUsdt, orderText, copyText, txUrl, addrUrl } from '../onboard/lib.js';

const { ethers } = window;
const PAID = iface.getEvent('Paid').topicHash;
const REFUNDED = iface.getEvent('Refunded').topicHash;
// V2 events. A v1 contract never emits them, so a receipt without them simply shows the v1 fields.
const V2 = new ethers.Interface([
  'event PayoutSplit(bytes32 indexed paymentId, address indexed to, uint256 amount)',
  'event RefundedBy(bytes32 indexed paymentId, address indexed by)',
]);
const SPLIT = V2.getEvent('PayoutSplit').topicHash;
const REFUNDED_BY = V2.getEvent('RefundedBy').topicHash;
const CHUNK = 10000;        // the node rejects eth_getLogs ranges above 10,000 blocks
const MAX_CHUNKS = 300;     // how far back to look for the Paid event (3M blocks)
const HASH = /^0x[0-9a-fA-F]{64}$/;

const when = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
const BAD = (m) => Object.assign(new Error(m), { friendly: true });

// ---------------------------------------------------------------- chain reads

async function pool(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

// Newest chunks first, 6 at a time, stopping at the first one that holds the event.
async function findLog(cfg, topics, head) {
  for (let c = 0; c < MAX_CHUNKS; c += 6) {
    const ranges = [];
    for (let i = c; i < Math.min(c + 6, MAX_CHUNKS); i++) {
      const to = head - i * CHUNK;
      if (to < 0) break;
      ranges.push([Math.max(0, to - CHUNK + 1), to]);
    }
    if (!ranges.length) return null;
    const res = await pool(ranges, 6, ([a, b]) => rpc(cfg).getLogs({ address: cfg.address, topics, fromBlock: a, toBlock: b }));
    const hit = res.flat()[0];
    if (hit) return hit;
  }
  return null;
}

// Refund transactions are extra detail: the refunded total comes from payments(), so a failure here is ignored.
async function findRefunds(cfg, id, fromBlock, head) {
  try {
    const ranges = [];
    for (let a = fromBlock; a <= head && ranges.length < 60; a += CHUNK) ranges.push([a, Math.min(head, a + CHUNK - 1)]);
    const res = (await pool(ranges, 6, ([a, b]) => rpc(cfg).getLogs({ address: cfg.address, topics: [[REFUNDED, REFUNDED_BY], id], fromBlock: a, toBlock: b }))).flat();
    const by = Object.fromEntries(res.filter((l) => l.topics[0] === REFUNDED_BY).map((l) => [l.transactionHash, ethers.getAddress('0x' + l.topics[2].slice(26))]));
    return res.filter((l) => l.topics[0] === REFUNDED)
      .map((l) => ({ hash: l.transactionHash, amount: iface.parseLog(l).args.amount, by: by[l.transactionHash] || null }));
  } catch {
    return [];
  }
}

async function load(cfg, q) {
  if (!cfg.configured) throw BAD('This deployment has no Sitebound contract address set.');
  const p = rpc(cfg);
  let id = q.id, log = null;
  if (q.tx) {
    const rc = await p.getTransactionReceipt(q.tx);
    if (!rc) throw BAD('No transaction with that hash on this network.');
    const mine = rc.logs.filter((l) => l.address.toLowerCase() === cfg.address.toLowerCase());
    log = mine.find((l) => l.topics[0] === PAID) || null;
    const any = log || mine.find((l) => l.topics[0] === REFUNDED);
    if (!any) throw BAD('That transaction is not a Sitebound payment.');
    id = any.topics[1];
  }
  const pm = await reader(cfg).payments(id);
  if (pm.wallet === ZERO) throw BAD('The contract has no payment with that id.');
  const head = await p.getBlockNumber();
  if (!log) log = await findLog(cfg, [PAID, id], head);
  if (!log) throw BAD('The payment exists, but its Paid event was not found in recent blocks.');
  const ev = iface.parseLog(log).args;
  // One PayoutSplit per recipient, in the same transaction, only when the site splits its payouts (V2).
  const splitsOf = async () => {
    try {
      const rc = await p.getTransactionReceipt(log.transactionHash);
      return (rc?.logs || [])
        .filter((l) => l.address.toLowerCase() === cfg.address.toLowerCase() && l.topics[0] === SPLIT && l.topics[1] === id)
        .map((l) => { const a = V2.parseLog(l).args; return { to: a.to, amount: a.amount }; });
    } catch { return []; }
  };
  const [block, refunds, splits] = await Promise.all([
    p.getBlock(log.blockNumber),
    pm.refunded > 0n ? findRefunds(cfg, id, log.blockNumber, head) : [],
    splitsOf(),
  ]);
  return {
    id, tx: log.transactionHash, site: ev.site, orderId: ev.orderId, payout: ev.payout,
    wallet: pm.wallet, amount: pm.amount, refunded: pm.refunded, time: new Date(block.timestamp * 1000), refunds, splits: splits.length > 1 ? splits.sort((a, b) => (b.to === ev.payout) - (a.to === ev.payout)) : [],
  };
}

// ---------------------------------------------------------------- view

function Copy({ text, what }) {
  const [done, setDone] = useState(false);
  const t = useRef();
  useEffect(() => () => clearTimeout(t.current), []);
  const click = async () => {
    if (!(await copyText(text))) return;
    setDone(true);
    clearTimeout(t.current);
    t.current = setTimeout(() => setDone(false), 1800);
  };
  return html`<button type="button" class=${'btn' + (done ? ' done' : '')} onClick=${click} aria-label=${'Copy ' + what}>${done ? 'Copied' : 'Copy'}</button>`;
}

// Share of the payment as a percentage, up to two decimals (10000 = whole payment, in basis points).
const share = (part, total) => {
  const bps = Number((part * 10000n) / total);
  return (bps / 100).toFixed(bps % 100 ? (bps % 10 ? 2 : 1) : 0) + '%';
};
const Hash = ({ value, what }) => html`<div class="cp"><span class="mono">${value}</span><${Copy} text=${value} what=${what} /></div>`;
const Row = ({ k, children }) => html`<div class="row"><dt>${k}</dt><dd>${children}</dd></div>`;
const Ext = ({ href, children }) => (href ? html`<a href=${href} target="_blank" rel="noopener noreferrer">${children}</a>` : children);

function stateOf(r) {
  if (r.refunded === 0n) return { cls: 'paid', label: 'Paid', note: '' };
  if (r.refunded >= r.amount) return { cls: '', label: 'Fully refunded', note: `${fmtUsdt(r.refunded)} USDT returned to the payer` };
  return { cls: '', label: 'Partly refunded', note: `${fmtUsdt(r.refunded)} of ${fmtUsdt(r.amount)} USDT returned to the payer` };
}

function Receipt({ cfg, r }) {
  const st = stateOf(r);
  const order = orderText(r.orderId);
  const url = txUrl(cfg, r.tx);
  useEffect(() => { document.title = `Receipt ${fmtUsdt(r.amount)} USDT, ${r.site}: Sitebound`; }, [r]);
  return html`
    <h1>Payment receipt</h1>
    <p class="sub">Read from the Sitebound contract on ${cfg.chainName}.</p>
    <article class="receipt">
      <div class="top">
        <div class="label">Amount paid</div>
        <div class="amount">${fmtUsdt(r.amount)}<small>USDT</small></div>
        <span class=${'state ' + st.cls}>${st.label}</span>${st.note && html`<span class="state-note">${st.note}</span>`}
      </div>
      <dl>
        <${Row} k="Website">${r.site}<//>
        <${Row} k="Order reference">${order ? html`<span class="mono">${order}</span>` : html`<span class="mono">${r.orderId}</span>`}${!order && html`<span class="hint">Not text; shown as raw bytes32.</span>`}<//>
        <${Row} k="Paid by"><${Hash} value=${r.wallet} what="payer wallet" /><//>
        ${r.splits.length
          ? html`<${Row} k="Split between"><ul class="splits">${r.splits.map((x) => html`<li key=${x.to}>
              <div class="cp"><span class="mono">${x.to}</span><${Copy} text=${x.to} what="recipient wallet" /></div>
              <span class="hint">${share(x.amount, r.amount)} · ${fmtUsdt(x.amount)} USDT</span></li>`)}</ul><//>`
          : html`<${Row} k="Paid to"><${Hash} value=${r.payout} what="payout wallet" /><//>`}
        <${Row} k="Time">${when.format(r.time)}<span class="hint">${r.time.toISOString()}</span><//>
        ${r.refunded > 0n && html`<${Row} k="Refunded">${fmtUsdt(r.refunded)} USDT${r.refunds.length > 0 && html`
          <ul class="sub-list">${r.refunds.map((f) => html`<li key=${f.hash}>${fmtUsdt(f.amount)} USDT${f.by && html`<br />by <span class="mono">${f.by}</span>`}<br />tx <${Ext} href=${txUrl(cfg, f.hash)}><span class="mono">${f.hash}</span><//></li>`)}</ul>`}<//>`}
        <${Row} k="Transaction"><${Hash} value=${r.tx} what="transaction hash" /><//>
        ${url && html`<${Row} k="Explorer"><${Ext} href=${url}><span class="mono">${url}</span><//><//>`}
        <${Row} k="Payment id"><${Hash} value=${r.id} what="payment id" /><//>
      </dl>
    </article>
    <section class="verify" aria-labelledby="v-h">
      <h2 id="v-h">Verify on-chain</h2>
      <p>This page keeps no records. Every value above was read from the Sitebound contract${' '}
        <${Ext} href=${addrUrl(cfg, cfg.address)}><span class="mono">${cfg.address}</span><//>${' '}
        on ${cfg.chainName} (chain ${cfg.chainId}). To check it yourself, open the transaction in the explorer and look for the Paid event from that contract address.</p>
    </section>`;
}

function Lookup({ message, head = true }) {
  const go = (e) => {
    e.preventDefault();
    const v = new FormData(e.target).get('ref').trim();
    if (HASH.test(v)) location.search = '?tx=' + v;
    else e.target.elements.ref.setCustomValidity('Enter a 0x-prefixed 64-digit hash.'), e.target.reportValidity();
  };
  return html`
    ${head && html`<h1>Payment receipt</h1>`}
    <p class="status">${message}</p>
    <form class="lookup" onSubmit=${go} novalidate>
      <input id="ref" name="ref" aria-label="Transaction hash" placeholder="Transaction hash 0x…" autocomplete="off" spellcheck="false" onInput=${(e) => e.target.setCustomValidity('')} />
      <button class="btn" type="submit">Find</button>
    </form>`;
}

function App({ cfg }) {
  const params = new URLSearchParams(location.search);
  const q = { id: params.get('id')?.trim(), tx: params.get('tx')?.trim() };
  const [s, setS] = useState({ phase: 'load' });
  const [n, setN] = useState(0);
  const printBtn = document.getElementById('print');

  useEffect(() => {
    if (!q.id && !q.tx) return;
    if (q.id && !HASH.test(q.id)) return setS({ phase: 'bad', msg: 'The payment id in this link is not a valid 32-byte hash.' });
    if (q.tx && !HASH.test(q.tx)) return setS({ phase: 'bad', msg: 'The transaction hash in this link is not valid.' });
    let live = true;
    setS({ phase: 'load' });
    load(cfg, q).then(
      (r) => live && setS({ phase: 'ok', r }),
      (e) => live && setS(e.friendly ? { phase: 'bad', msg: e.message } : { phase: 'fail', msg: readText(e) }),
    );
    return () => { live = false; };
  }, [n]);

  useEffect(() => { printBtn.hidden = s.phase !== 'ok'; }, [s.phase]);
  printBtn.onclick = () => window.print();

  if (!q.id && !q.tx) return html`<${Lookup} message="Paste a transaction hash to open its receipt." />`;
  if (s.phase === 'load') return html`<p class="status" role="status">Reading the payment from the chain…</p>`;
  if (s.phase === 'bad') return html`<h1>Receipt not available</h1><p class="status err" role="alert">${s.msg}</p><${Lookup} head=${false} message="Try another transaction hash." />`;
  if (s.phase === 'fail') return html`<h1>Receipt not available</h1><p class="status err" role="alert">${s.msg}</p><button class="btn retry" type="button" onClick=${() => setN(n + 1)}>Try again</button>`;
  return html`<${Receipt} cfg=${cfg} r=${s.r} />`;
}

// ---------------------------------------------------------------- boot

const themeBtn = document.getElementById('theme');
function syncTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#07080a' : '#fafaf7');
}
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('sitebound.theme', next); } catch { /* private mode */ }
  syncTheme();
});
syncTheme();

const app = document.getElementById('app');
const { cfg, error } = await loadConfig();
if (error) render(html`<p class="status err" role="alert">This page is missing its network settings.</p>`, app);
else render(html`<${App} cfg=${cfg} />`, app);
