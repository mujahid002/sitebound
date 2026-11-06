// Shop dashboard: payments to one site, read from chain events. Refunds, CSV, webhook test.
import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { html, Brand, Icon, Spinner, Notice, TxLink, AddrLink, Empty, useTick } from '../onboard/ui.js';
import {
  ABI, ERC20, iface, ZERO, loadConfig, parseSite, rpc, reader, contractState, readSite, secondsLeft, useWallet,
  errText, readText, short, sameAddr, fmtUsdt, parseUsdt, orderText, duration, txUrl,
} from '../onboard/lib.js';

const { ethers } = window;
const SPAN = 50000;   // blocks per "page"
const CHUNK = 5000;   // blocks per eth_getLogs call
const PAID = iface.getEvent('Paid').topicHash;
const REFUNDED = iface.getEvent('Refunded').topicHash;

const timeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const timeYearFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtTime = { format: (d) => (d.getFullYear() === new Date().getFullYear() ? timeFmt : timeYearFmt).format(d) };

// ---------------------------------------------------------------- chain reads

async function pool(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

// One page: Paid logs for this site in [to - SPAN + 1, to], newest first, with times and refund state.
async function loadPage(cfg, siteHash, to, head) {
  const from = Math.max(0, to - SPAN + 1);
  const ranges = [];
  for (let end = to; end >= from; end -= CHUNK) ranges.push([Math.max(from, end - CHUNK + 1), end]);
  const topics = [PAID, null, siteHash]; // topic1 is paymentId, topic2 the site
  const chunks = await pool(ranges, 3, ([a, b]) => rpc(cfg).getLogs({ address: cfg.address, topics, fromBlock: a, toBlock: b }));
  const logs = chunks.flat();

  const rows = logs.map((l) => {
    const e = iface.parseLog(l).args;
    return { id: e.paymentId, order: e.orderId, buyer: e.wallet, amount: e.amount, block: l.blockNumber, idx: l.index, tx: l.transactionHash, refunded: 0n, refundTxs: [], time: 0 };
  }).sort((x, y) => y.block - x.block || y.idx - x.idx);

  const blocks = [...new Set(rows.map((r) => r.block))];
  const times = new Map(await pool(blocks, 20, async (n) => [n, Number((await rpc(cfg).getBlock(n)).timestamp)]));
  const pays = await pool(rows, 40, (r) => reader(cfg).payments(r.id));
  rows.forEach((r, i) => { r.time = times.get(r.block); r.refunded = pays[i].refunded; });

  // Refund transactions, only for display; the amounts above come from payments().
  // Filtered by payment id, so these are cheap calls, but they must reach up to the chain head.
  const withRefund = rows.filter((r) => r.refunded > 0n);
  if (withRefund.length) {
    const lo = Math.min(...withRefund.map((r) => r.block));
    const spans = [];
    for (let a = lo; a <= head && spans.length < 40; a += CHUNK) spans.push([a, Math.min(head, a + CHUNK - 1)]);
    const ids = withRefund.map((r) => r.id).slice(0, 100);
    await pool(spans, 3, async ([a, b]) => {
      try {
        const rl = await rpc(cfg).getLogs({ address: cfg.address, topics: [REFUNDED, ids], fromBlock: a, toBlock: b });
        for (const l of rl) withRefund.find((r) => r.id === l.topics[1])?.refundTxs.push(l.transactionHash);
      } catch { /* a refused range only loses its tx links; the status still shows */ }
    });
  }
  return { rows, from };
}

// ---------------------------------------------------------------- csv + webhook

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // order ids come from buyers' browsers: no spreadsheet formulas
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const plain = (v) => { const [i, f = ''] = ethers.formatUnits(v, 6).split('.'); return i + '.' + f.padEnd(2, '0'); };
function toCsv(rows) {
  const head = ['time_utc', 'order_id', 'order_id_hex', 'buyer', 'amount_usdt', 'refunded_usdt', 'status', 'payment_id', 'tx_hash'];
  const lines = rows.map((r) => [
    new Date(r.time * 1000).toISOString(), orderText(r.order) ?? '', r.order, r.buyer,
    plain(r.amount), plain(r.refunded), statusOf(r).label, r.id, r.tx,
  ].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Whole-cent text for the big numbers (cut, never rounded up).
const cents = (v) => fmtUsdt(v - (v % 10000n));
const inputOf = (v) => ethers.formatUnits(v, 6).replace(/\.0$/, '');

function statusOf(r) {
  if (r.refunded === 0n) return { kind: 'ok', label: 'Paid' };
  if (r.refunded >= r.amount) return { kind: 'muted', label: 'Refunded' };
  return { kind: 'warn', label: `Refunded ${fmtUsdt(r.refunded)} of ${fmtUsdt(r.amount)}` };
}

// ---------------------------------------------------------------- page

function App() {
  const [boot, setBoot] = useState({ status: 'loading' });
  useEffect(() => { loadConfig().then((r) => setBoot(r.error ? { status: 'error', error: r.error } : { status: 'ready', cfg: r.cfg })); }, []);
  const site = parseSite(new URLSearchParams(location.search).get('site'), { allowHttp: true });

  let body;
  if (site.error) {
    body = html`<${Empty} title="Which shop?" action=${html`<a class="btn" href="../landing/index.html#site">Type your website</a>`}>
      Open the dashboard with <span class="mono">?site=https://your-shop.com</span>, with the exact site you registered.<//>`;
  } else if (boot.status === 'loading') {
    body = html`<p class="lede" role="status">Loading your orders…</p>`;
  } else if (boot.status === 'error') {
    body = html`<${Empty} title="The dashboard is not configured yet">
      It needs the site's <span class="mono">config.js</span> (chain, RPC and contract address).<//>`;
  } else {
    return html`<${Dashboard} cfg=${boot.cfg} site=${site} />`;
  }
  return html`<header class="bar"><${Brand} /></header><main id="main" class="page">${body}</main>`;
}

// Orders for one site, read from chain events. Also used inline by the landing page (web/landing/kit.js).
export function useOrders(cfg, site) {
  const [chain, setChain] = useState({ status: 'loading' });
  const [feed, setFeed] = useState({ rows: [], from: null, head: null, loading: true, error: '', more: false });
  const [refund, setRefund] = useState(null);
  const gen = useRef(0);
  const feedRef = useRef(feed);
  feedRef.current = feed;

  const load = useCallback(async (older) => {
    const my = older ? gen.current : ++gen.current;
    setFeed((f) => (older ? { ...f, loading: true, error: '' } : { rows: [], from: null, head: null, loading: true, error: '', more: false }));
    try {
      if (!older) {
        if ((await contractState(cfg)) === 'none') return setChain({ status: 'none' });
        const info = await readSite(cfg, site.siteHash);
        if (my !== gen.current) return;
        setChain({ status: 'ok', info });
      }
      const head = older ? null : await rpc(cfg).getBlockNumber();
      const to = older ? feedRef.current.from - 1 : head;
      const page = await loadPage(cfg, site.siteHash, to, older ? feedRef.current.head : head);
      if (my !== gen.current) return;
      setFeed((f) => ({
        rows: [...f.rows, ...page.rows], from: page.from, head: older ? f.head : head,
        loading: false, error: '', more: page.from > 0,
      }));
    } catch (e) {
      if (my !== gen.current) return;
      setFeed((f) => ({ ...f, loading: false, error: readText(e) }));
      setChain((c) => (c.status === 'loading' ? { status: 'error', message: readText(e) } : c));
    }
  }, [cfg, site.siteHash]);
  useEffect(() => { load(false); }, [load]);

  const info = chain.status === 'ok' ? chain.info : null;
  const rowDone = async (id, txHash) => {
    const pm = await reader(cfg).payments(id);
    setFeed((f) => ({ ...f, rows: f.rows.map((r) => (r.id === id ? { ...r, refunded: pm.refunded, refundTxs: [...r.refundTxs, txHash] } : r)) }));
    setRefund((r) => (r && r.id === id ? { ...r, refunded: pm.refunded } : r));
  };
  return { chain, info, feed, load, refund, setRefund, rowDone };
}

function Dashboard({ cfg, site }) {
  const wallet = useWallet(cfg);
  const { chain, info, feed, load, refund, setRefund, rowDone } = useOrders(cfg, site);
  const isPayout = !!info && sameAddr(wallet.account, info.payout);

  let content;
  if (chain.status === 'none') {
    content = html`<${Empty} title="Not deployed yet" action=${html`<a class="btn ghost" href=${'../onboard/index.html?site=' + encodeURIComponent(site.origin)}>Set up your shop</a>`}>
      The Sitebound contract has no address on ${cfg.chainName} yet, so there are no payments to show. This page fills in once it is live.<//>`;
  } else if (chain.status === 'error') {
    content = html`<${Notice} kind="error" title="Could not read the chain">${chain.message}
      <div class="row"><button class="link-btn" onClick=${() => load(false)}>Try again</button></div><//>`;
  } else {
    content = html`
      ${info && !info.registered && html`<${Notice} kind="warn" title="This site is not registered yet">
        Payments only reach you after you register it. <a href=${'../onboard/index.html?site=' + encodeURIComponent(site.origin)}>Set up your shop</a>.<//>`}
      <${Totals} feed=${feed} />
      <${Orders} cfg=${cfg} site=${site} feed=${feed} load=${load} onRefund=${setRefund} />
      <${Webhook} site=${site} />`;
  }

  return html`
    <header class="bar">
      <${Brand} />
      <div class="bar-end">${chain.status === 'ok' && html`<${WalletChip} wallet=${wallet} isPayout=${isPayout} />`}</div>
    </header>
    <main id="main" class="page wide">
      <div class="head">
        <p class="eyebrow">Orders</p>
        <h1 class="h1">${site.host}</h1>
        ${info?.registered && html`<${SiteLine} cfg=${cfg} info=${info} />`}
      </div>
      ${content}
    </main>
    ${refund && html`<${RefundDialog} cfg=${cfg} row=${refund} info=${info} wallet=${wallet} isPayout=${isPayout}
      onClose=${() => setRefund(null)} onDone=${rowDone} />`}
    <footer class="foot wide-foot">
      <p>Read straight from ${cfg.chainName}. Nothing here is stored on a Sitebound server.</p>
    </footer>`;
}

function SiteLine({ cfg, info }) {
  useTick(1000, !!info.pending);
  return html`<p class="siteline">
    ${info.frozen ? html`<span class="badge err">Frozen</span>` : info.pending ? html`<span class="badge warn">Payout change pending</span>` : html`<span class="badge ok">Active</span>`}
    <span>Paying <${AddrLink} cfg=${cfg} address=${info.payout} /></span>
    ${info.pending && html`<span class="hint">New wallet <${AddrLink} cfg=${cfg} address=${info.pending} /> in ${duration(secondsLeft(info))}</span>`}
  </p>`;
}

export function WalletChip({ wallet, isPayout }) {
  if (!wallet.hasWallet) return html`<span class="hint">No wallet found</span>`;
  if (!wallet.account || !wallet.onChain) {
    return html`<button class="btn ghost sm" onClick=${wallet.connect} disabled=${wallet.busy}>
      ${wallet.busy ? html`<${Spinner} />` : null}${wallet.account ? 'Switch network' : 'Connect wallet'}</button>`;
  }
  return html`<span class=${'badge ' + (isPayout ? 'ok' : 'warn')} title=${wallet.account}>
    <span class="mono">${short(wallet.account)}</span><span class="chip-role">${isPayout ? 'payout wallet' : 'not the payout wallet'}</span></span>`;
}

// ---------------------------------------------------------------- totals + orders

export function Totals({ feed }) {
  const count = feed.rows.length;
  const volume = feed.rows.reduce((s, r) => s + r.amount, 0n);
  const refunded = feed.rows.reduce((s, r) => s + r.refunded, 0n);
  const first = feed.loading && !count;
  const stat = (label, value, unit) => html`<div class="stat"><dt>${label}</dt>
    <dd>${first ? html`<span class="skel" aria-hidden="true"></span><span class="sr-only">Loading</span>` : html`${value}${unit ? html`<small>${unit}</small>` : null}`}</dd></div>`;
  return html`<section class="totals" aria-label="Totals">
    <dl>${stat('Payments', count.toLocaleString())}${stat('Volume', cents(volume))}${stat('Refunded', cents(refunded))}</dl>
    ${feed.from !== null && html`<p class="hint">Counts blocks ${feed.from.toLocaleString()} to ${feed.head?.toLocaleString()}${feed.more ? '. Load older orders to include earlier ones.' : '. This is the whole history.'} Amounts are in USDT.</p>`}
  </section>`;
}

export function Orders({ cfg, site, feed, load, onRefund }) {
  const { rows, loading, error, more } = feed;
  const exportCsv = () => download(`sitebound-${site.hostname}-orders.csv`, toCsv(rows));
  let inner;
  if (loading && !rows.length) {
    inner = html`<div class="skeleton-rows" role="status"><span class="sr-only">Loading orders</span>
      ${[0, 1, 2].map(() => html`<div class="skel-row" aria-hidden="true"><span class="skel"></span><span class="skel short"></span></div>`)}</div>`;
  } else if (error && !rows.length) {
    inner = html`<${Notice} kind="error" title="Could not load orders">${error}
      <div class="row"><button class="link-btn" onClick=${() => load(false)}>Try again</button></div><//>`;
  } else if (!rows.length) {
    inner = html`<${Empty} title="No payments yet" action=${html`<a class="btn ghost" href=${'../onboard/index.html?site=' + encodeURIComponent(site.origin)}>Get the checkout snippet</a>`}>
      ${more ? 'Nothing in the recent blocks. Older orders may be further back.' : 'Once a buyer pays through Sitebound, the order shows up here.'}<//>`;
  } else {
    inner = html`<div class="table" role="table" aria-label="Orders">
      <div class="thead" role="rowgroup"><div class="tr" role="row">
        <span role="columnheader">Order</span><span role="columnheader">Time</span><span role="columnheader">Buyer</span>
        <span role="columnheader" class="num">Amount</span><span role="columnheader">Status</span><span role="columnheader"><span class="sr-only">Actions</span></span>
      </div></div>
      <div role="rowgroup">${rows.map((r) => html`<${OrderRow} key=${r.id} cfg=${cfg} r=${r} onRefund=${onRefund} />`)}</div>
    </div>`;
  }
  return html`<section class="orders" aria-labelledby="orders-h">
    <div class="orders-top">
      <h2 id="orders-h" class="sect">Orders</h2>
      <div class="row">
        <button class="btn ghost sm" onClick=${() => load(false)} disabled=${loading}>Refresh</button>
        <button class="btn ghost sm" onClick=${exportCsv} disabled=${!rows.length}>Export CSV</button>
      </div>
    </div>
    ${inner}
    ${error && rows.length > 0 && html`<${Notice} kind="error" title="Could not load more">${error}<//>`}
    ${more && rows.length > 0 && html`<div class="more"><button class="btn ghost" onClick=${() => load(true)} disabled=${loading}>
      ${loading ? html`<${Spinner} />` : null}${loading ? 'Loading…' : 'Load older'}</button></div>`}
  </section>`;
}

function OrderRow({ cfg, r, onRefund }) {
  const text = orderText(r.order);
  const st = statusOf(r);
  const left = r.amount - r.refunded;
  return html`<div class="tr" role="row">
    <span role="cell" class="c-order"><span class=${text ? 'order' : 'order mono'} title=${r.order}>${text ?? short(r.order)}</span></span>
    <span role="cell" class="c-time">${fmtTime.format(new Date(r.time * 1000))}</span>
    <span role="cell" class="c-buyer mono" title=${r.buyer}>${short(r.buyer)}</span>
    <span role="cell" class="c-amt num">${fmtUsdt(r.amount)} <small>USDT</small></span>
    <span role="cell" class="c-status"><span class=${'badge ' + (st.kind === 'ok' ? 'ok' : st.kind === 'warn' ? 'warn' : '')}>${st.label}</span></span>
    <span role="cell" class="c-act">
      <${TxLink} cfg=${cfg} hash=${r.tx}>Tx<//>
      ${left > 0n && html`<button class="btn ghost sm" onClick=${() => onRefund(r)} aria-label=${'Refund order ' + (text ?? short(r.order))}>Refund</button>`}
    </span>
  </div>`;
}

// ---------------------------------------------------------------- refund dialog

export function RefundDialog({ cfg, row, info, wallet, isPayout, onClose, onDone }) {
  const ref = useRef();
  const left = row.amount - row.refunded;
  const [val, setVal] = useState(inputOf(left));
  const [step, setStep] = useState({ phase: 'idle' });
  const working = ['approve', 'approving', 'refund', 'refunding'].includes(step.phase);
  const text = orderText(row.order);

  useEffect(() => {
    const d = ref.current;
    d.showModal();
    return () => d.open && d.close();
  }, []);

  const amount = parseUsdt(val);
  const bad = amount === null ? 'Enter an amount like 12.50.' : amount === 0n ? 'The amount must be more than zero.' : amount > left ? `At most ${fmtUsdt(left)} is left to refund.` : '';

  const submit = async (e) => {
    e.preventDefault();
    if (bad || working) return;
    try {
      setStep({ phase: 'approve' });
      const signer = await wallet.getSigner();
      const token = new ethers.Contract(cfg.token, ERC20, signer);
      const me = await signer.getAddress();
      const [bal, allow] = await Promise.all([token.balanceOf(me), token.allowance(me, cfg.address)]);
      if (bal < amount) throw new Error(`This wallet holds ${fmtUsdt(bal)} USDT but the refund needs ${fmtUsdt(amount)}.`);
      let approveHash;
      if (allow < amount) {
        const a = await token.approve(cfg.address, amount);
        approveHash = a.hash;
        setStep({ phase: 'approving', approveHash });
        await a.wait();
      }
      setStep({ phase: 'refund', approveHash });
      const c = new ethers.Contract(cfg.address, ABI, signer);
      const t = await c.refund(row.id, amount);
      setStep({ phase: 'refunding', approveHash, hash: t.hash });
      await t.wait();
      await onDone(row.id, t.hash);
      setStep({ phase: 'done', approveHash, hash: t.hash });
    } catch (err) {
      setStep((s) => ({ phase: 'error', message: errText(err), approveHash: s.approveHash }));
    }
  };

  const walletOk = wallet.account && wallet.onChain && isPayout;
  const label = { approve: 'Check wallet…', approving: 'Approving USDT…', refund: 'Confirm in your wallet…', refunding: 'Refunding…' }[step.phase];

  return html`<dialog ref=${ref} class="dlg" aria-labelledby="dlg-h" onCancel=${(e) => working && e.preventDefault()} onClose=${onClose}
      onClick=${(e) => e.target === ref.current && !working && ref.current.close()}>
    <form class="dlg-body" onSubmit=${submit} noValidate>
      <div class="dlg-top"><h2 id="dlg-h">Refund ${text ? html`<span class="order">${text}</span>` : 'payment'}</h2>
        <button type="button" class="icon-btn" aria-label="Close" onClick=${() => ref.current.close()} disabled=${working}>×</button></div>

      <dl class="facts">
        <div><dt>Goes back to</dt><dd><${AddrLink} cfg=${cfg} address=${row.buyer} full=${true} /></dd></div>
        <div class="pair">
          <div><dt>Paid</dt><dd>${fmtUsdt(row.amount)} USDT</dd></div>
          <div><dt>Already refunded</dt><dd>${fmtUsdt(row.refunded)} USDT</dd></div>
        </div>
      </dl>
      <p class="hint strong">Refunds can only go to the wallet that paid. The contract sends them there, and nobody can pick another address.</p>

      <div class="field">
        <label for="amt">Refund amount (USDT)</label>
        <div class="amt-row">
          <input id="amt" class="input" inputmode="decimal" autocomplete="off" value=${val} aria-invalid=${bad ? 'true' : 'false'}
            aria-describedby="amt-msg" disabled=${working || step.phase === 'done'} onInput=${(e) => setVal(e.target.value)} />
          <button type="button" class="btn ghost sm" onClick=${() => setVal(inputOf(left))} disabled=${working}>Max</button>
        </div>
        <p id="amt-msg" class=${'hint' + (bad ? ' err' : '')}>${bad || `Up to ${fmtUsdt(left)} USDT. Your wallet pays it from its own USDT.`}</p>
      </div>

      ${!wallet.account || !wallet.onChain
        ? html`<${Notice} kind="info" title="Connect the payout wallet">Refunds are sent from the wallet that receives your payments.
            <div class="row"><button type="button" class="btn sm" onClick=${wallet.connect} disabled=${wallet.busy}>${wallet.account ? 'Switch network' : 'Connect wallet'}</button></div><//>`
        : !isPayout && html`<${Notice} kind="warn" title="This is not the payout wallet">Connected as <span class="mono">${short(wallet.account)}</span>. Switch to <span class="mono">${short(info.payout)}</span> in your wallet to refund.<//>`}
      ${wallet.error && html`<p class="hint err" role="alert">${wallet.error}</p>`}

      <div aria-live="polite" class="live">
        ${step.approveHash && html`<p class="hint">Approval: <${TxLink} cfg=${cfg} hash=${step.approveHash} /></p>`}
        ${step.hash && html`<p class="hint">Refund: <${TxLink} cfg=${cfg} hash=${step.hash} /></p>`}
        ${step.phase === 'done' && html`<${Notice} kind="ok" title="Refund sent">The buyer's wallet has the USDT back.<//>`}
        ${step.phase === 'error' && html`<${Notice} kind="error" title="Refund did not go through">${step.message}<//>`}
      </div>

      <div class="dlg-actions">
        ${step.phase === 'done'
          ? html`<button type="button" class="btn" onClick=${() => ref.current.close()}>Done</button>`
          : html`<button type="button" class="btn ghost" onClick=${() => ref.current.close()} disabled=${working}>Cancel</button>
            <button type="submit" class="btn" disabled=${!walletOk || !!bad || working}>
              ${working ? html`<${Spinner} />` : null}${working ? label : 'Refund'}</button>`}
      </div>
      <p class="hint">If USDT allowance is short, your wallet asks for an approval first, then the refund.</p>
    </form>
  </dialog>`;
}

// ---------------------------------------------------------------- webhook (stored in the browser only)

const SAMPLE = {
  orderId: 'TEST-1001', status: 'paid',
  paymentId: '0x' + '00'.repeat(31) + '01', txHash: '0x' + '00'.repeat(31) + '02', amount: '12.00',
};
function webhookOk(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(x.hostname));
  } catch { return false; }
}

function Webhook({ site }) {
  const key = 'sitebound.webhook.' + site.origin;
  const [url, setUrl] = useState(() => { try { return localStorage.getItem(key) || ''; } catch { return ''; } });
  const [saved, setSaved] = useState(url);
  const [res, setRes] = useState(null);
  const bad = url && !webhookOk(url) ? 'Use an https address (http only for localhost).' : '';

  const save = () => {
    try { url ? localStorage.setItem(key, url) : localStorage.removeItem(key); } catch { /* private mode */ }
    setSaved(url);
  };
  const test = async () => {
    setRes({ state: 'sending' });
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(SAMPLE), signal: AbortSignal.timeout(10000) });
      setRes({ state: r.ok ? 'ok' : 'http', code: r.status });
    } catch {
      setRes({ state: 'fail' });
    }
  };
  return html`<section class="webhook" aria-labelledby="wh-h">
    <div class="orders-top"><h2 id="wh-h" class="sect">Webhook</h2><span class="badge warn">Not wired yet</span></div>
    <p class="hint">Real webhooks need the Sitebound relayer to watch for payments and post them to your server. That part is not built, so nothing is sent for real orders. This box saves the address in this browser only and lets you check that your endpoint accepts the format.</p>
    <div class="field">
      <label for="wh">Webhook URL</label>
      <input id="wh" class="input" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://shop.com/webhook"
        value=${url} aria-invalid=${bad ? 'true' : 'false'} aria-describedby="wh-msg" onInput=${(e) => { setUrl(e.target.value.trim()); setRes(null); }} />
      <p id="wh-msg" class=${'hint' + (bad ? ' err' : '')}>${bad}</p>
    </div>
    <div class="row">
      <button class="btn ghost sm" onClick=${save} disabled=${!!bad || url === saved}>${url === saved && saved ? 'Saved' : 'Save'}</button>
      <button class="btn ghost sm" onClick=${test} disabled=${!url || !!bad || res?.state === 'sending'}>
        ${res?.state === 'sending' ? html`<${Spinner} />` : null}Send test</button>
    </div>
    <div aria-live="polite" class="live">
      ${res?.state === 'ok' && html`<${Notice} kind="ok" title="Your endpoint answered">It replied ${res.code}. This was sample data, not a real order.<//>`}
      ${res?.state === 'http' && html`<${Notice} kind="warn" title="Your endpoint rejected the test">It replied ${res.code}.<//>`}
      ${res?.state === 'fail' && html`<${Notice} kind="error" title="Could not reach that address">The request failed. The server may be offline, or it does not allow requests from this page (CORS).<//>`}
    </div>
    <details class="sample"><summary>Sample payload</summary><pre class="code" tabindex="0">${JSON.stringify(SAMPLE, null, 2)}</pre></details>
  </section>`;
}

// The landing page imports the pieces above and has no #app, so only the dashboard page renders here.
const root = document.getElementById('app');
if (root) render(html`<${App} />`, root);
