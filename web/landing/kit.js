// The shop kit on the landing page: setup (onboarding's Shop), a live button preview and a mini dashboard.
// Everything that touches the chain or the relayer comes from web/onboard and web/dashboard, unforked.
import { render } from 'preact';
import { useState, useEffect, useMemo } from 'preact/hooks';
import { html, Notice, Spinner, AddrLink } from '../onboard/ui.js';
import { loadConfig, parseSite, useWallet, sameAddr } from '../onboard/lib.js';
import { Shop } from '../onboard/app.js';
import { useOrders, Totals, Orders, RefundDialog, WalletChip } from '../dashboard/app.js';

let config;
export function openKit(root, origin, { onChange }) {
  config ||= loadConfig();
  render(html`<${Kit} key=${origin} origin=${origin} config=${config} onChange=${onChange} />`, root);
}

function Kit({ origin, config, onChange }) {
  const [boot, setBoot] = useState(null);
  const [read, setRead] = useState({ info: null, status: 'loading' });
  const { info } = read;
  useEffect(() => { config.then(setBoot); }, [config]);
  const site = parseSite(origin);

  if (!boot) return html`<p class="lede kit-loading" role="status">Loading your shop setup…</p>`;
  if (boot.error) {
    return html`<${Notice} kind="error" title="Setup is not configured on this host">
      The page needs its <span class="mono">config.js</span> (chain, RPC, relayer and contract address).<//>`;
  }
  if (site.error) {
    return html`<${Notice} kind="warn" title="Sitebound needs an https site">Type a site like shop.com.
      <div class="row"><button class="link-btn" onClick=${onChange}>Change the site</button></div><//>`;
  }
  const cfg = boot.cfg;
  return html`
    <${SiteBadge} cfg=${cfg} site=${site} info=${info} status=${read.status} />
    <${Shop} cfg=${cfg} site=${site} onChangeSite=${onChange} onInfo=${(i, status) => setRead({ info: i, status })} snippetExtra=${html`<${TestCheckout} cfg=${cfg} site=${site} />`} />
    ${info?.registered && html`<${MiniDashboard} cfg=${cfg} site=${site} />`}
    <p class="kit-trust">Only the owner of ${site.host} can choose where its payments go: the DNS TXT record names the payout wallet, and that is
      the only wallet the relayer registers for the site. The relayer is a trusted step in this version.</p>`;
}

// One line on top: is this site on Sitebound, and who does it pay?
function SiteBadge({ cfg, site, info, status }) {
  if (status === 'none' || status === 'error') return null; // Shop shows its own notice for these
  if (!info) return html`<p class="kit-status" role="status"><${Spinner} /> Checking ${site.host} on ${cfg.chainName}…</p>`;
  if (!info.registered) {
    return html`<p class="kit-status"><span class="badge">Not on Sitebound yet</span>
      <span>Payments to ${site.host} would fail until its owner sets it up below.</span></p>`;
  }
  return html`<p class="kit-status">
    ${info.frozen ? html`<span class="badge err">Frozen</span>` : html`<span class="badge ok">On Sitebound</span>`}
    <span>Pays <${AddrLink} cfg=${cfg} address=${info.payout} /></span></p>`;
}

// Test checkout: the real button and frame, with an amount the owner picks. The frame always names the site
// the buyer is actually on (the browser reports it), so on this page it names this page's host, not the shop.
function TestCheckout({ cfg, site }) {
  const [ready, setReady] = useState(() => !!customElements.get('sitebound-pay'));
  const [failed, setFailed] = useState(false);
  const [amount, setAmount] = useState('1.00');
  const order = useMemo(() => 'TEST-' + Date.now().toString(36).toUpperCase(), []);
  const ok = /^\d{1,6}(\.\d{1,6})?$/.test(amount) && Number(amount) > 0;
  useEffect(() => {
    if (ready) return;
    const s = Object.assign(document.createElement('script'), {
      src: (cfg.frameOrigin || location.origin) + '/button/sitebound.js',
      onload: () => customElements.whenDefined('sitebound-pay').then(() => setReady(true)),
      onerror: () => setFailed(true),
    });
    document.head.append(s);
  }, []);
  return html`<div class="preview">
    <div class="code-top"><span class="kv-label">Test checkout</span></div>
    <div class="test-row">
      <div class="field test-amt">
        <label for="test-amt">Amount (USDT)</label>
        <input id="test-amt" class="input" inputmode="decimal" autocomplete="off" value=${amount}
          aria-invalid=${ok ? 'false' : 'true'} onInput=${(e) => setAmount(e.target.value.trim())} />
      </div>
      <div class="test-go">
        ${failed ? html`<p class="hint err">The button script did not load.</p>`
          : !ready ? html`<${Spinner} />`
          : ok ? html`<sitebound-pay amount=${amount} order=${order}></sitebound-pay>`
          : html`<p class="hint err">Enter an amount like 1.00.</p>`}
      </div>
    </div>
    <p class="hint">Opens the real Sitebound frame: "Pay ${ok ? amount : '…'} USDT to" the site in the buyer's address bar, with no wallet address anywhere.
      On this page that is <strong>${location.host}</strong>, which is not registered, so nothing can be paid here.
      Pasted on your shop, the same button says <strong>Pay ${ok ? amount : '…'} USDT to ${site.host}</strong>.</p>
  </div>`;
}

function MiniDashboard({ cfg, site }) {
  const wallet = useWallet(cfg);
  const { chain, info, feed, load, refund, setRefund, rowDone } = useOrders(cfg, site);
  const isPayout = !!info && sameAddr(wallet.account, info.payout);
  return html`<section class="mini-dash" aria-labelledby="mini-h">
    <div class="mini-top">
      <div><p class="eyebrow">Dashboard</p><h2 id="mini-h" class="sect">Payments to ${site.host}</h2></div>
      <div class="row">
        ${chain.status === 'ok' && html`<${WalletChip} wallet=${wallet} isPayout=${isPayout} />`}
        <a class="btn ghost sm" href=${'../dashboard/index.html?site=' + encodeURIComponent(site.origin)}>Full dashboard</a>
      </div>
    </div>
    ${chain.status === 'error'
      ? html`<${Notice} kind="error" title="Could not read the chain">${chain.message}
          <div class="row"><button class="link-btn" onClick=${() => load(false)}>Try again</button></div><//>`
      : html`<${Totals} feed=${feed} /><${Orders} cfg=${cfg} site=${site} feed=${feed} load=${load} onRefund=${setRefund} />`}
    ${refund && html`<${RefundDialog} cfg=${cfg} row=${refund} info=${info} wallet=${wallet} isPayout=${isPayout}
      onClose=${() => setRefund(null)} onDone=${rowDone} />`}
  </section>`;
}
