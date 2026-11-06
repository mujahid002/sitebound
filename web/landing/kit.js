// The setup kit on the landing page: setup (onboarding's Shop), a live button preview and a mini dashboard.
// Everything that touches the chain or the relayer comes from web/onboard and web/dashboard, unforked.
import { render } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { html, Notice, Spinner, Icon } from '../onboard/ui.js';
import { loadConfig, parseSite, useWallet, sameAddr, short } from '../onboard/lib.js';
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

  if (!boot) return html`<p class="lede kit-loading" role="status">Loading your site setup…</p>`;
  if (boot.error) {
    return html`<${Notice} kind="error" title="Setup is not configured on this host">
      The page needs its <span class="mono">config.js</span> (chain, RPC, relayer and contract address).<//>`;
  }
  if (site.error) {
    return html`<${Notice} kind="warn" title="Sitebound needs an https site">Type a site like example.com.
      <div class="row"><button class="link-btn" onClick=${onChange}>Change the site</button></div><//>`;
  }
  const cfg = boot.cfg;
  return html`
    <${Wizard} site=${site} info=${info} onChange=${onChange}>
      <${Shop} cfg=${cfg} site=${site} onChangeSite=${onChange} onInfo=${(i, status) => setRead({ info: i, status })} snippetExtra=${html`<${TestCheckout} cfg=${cfg} site=${site} />`} />
    <//>
    ${info?.registered && html`<${MiniDashboard} cfg=${cfg} site=${site} />`}
    <p class="kit-trust">Only the owner of ${site.host} can choose where its payments go: the DNS TXT record names the payout wallet, and that is
      the only wallet the relayer registers for the site. The relayer is a trusted step in this version.</p>`;
}

// ---------------------------------------------------------------- the five-step wizard
// Onboarding's Shop owns the logic (wallet, DNS check, register, snippet) and renders four steps. This wrapper adds the
// first step (the website, already typed), a progress rail, the one-line reason for the current step, focus and live
// announcements, and re-checks DNS every few seconds. It reads Shop's step list from the DOM, so it follows whatever
// Shop decides; CSS hides Shop's own header and the steps that are not current.
const STEPS = [
  { label: 'Website', title: 'Your website', why: 'This is the site that will take payments.' },
  { label: 'Wallet', title: 'Connect your wallet', why: 'Buyers send USDT straight to this wallet. Sitebound never holds the money.' },
  { label: 'DNS record', title: 'Add one DNS record', why: 'Only the domain owner can add this record, so only you can choose where the money goes.' },
  { label: 'Register', title: 'Register your site', why: 'This records your wallet on chain against this domain, so every payment from it can find you.' },
  { label: 'Add to site', title: 'Add the button to your site', why: 'The page never holds an address, so a hacked page cannot redirect a payment.' },
];
const DNS_EVERY_MS = 5000;
const DNS_MAX = 36;

// Shop's <li class="step done|current|todo"> list, as [{ state, sum }] for steps 2 to 5.
function readSteps(root) {
  return [...root.querySelectorAll('ol.stepper > li.step')].map((li) => ({
    state: li.classList.contains('done') ? 'done' : li.classList.contains('current') ? 'current' : 'todo',
    sum: (li.querySelector('.step-sum')?.textContent?.trim() || '').split(' on ')[0],
  }));
}

function Wizard({ site, info, onChange, children }) {
  const ref = useRef();
  const head = useRef();
  const [steps, setSteps] = useState([]);
  const [dnsTry, setDnsTry] = useState(0);
  const [paused, setPaused] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    const el = ref.current;
    const sync = () => setSteps((old) => {
      const next = readSteps(el);
      return JSON.stringify(old) === JSON.stringify(next) ? old : next;
    });
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);

  const cur = steps.findIndex((s) => s.state === 'current') + 1; // 0 until Shop has rendered; then 1..4 (rail 2..5)
  const at = cur ? cur : 1;
  const registered = at === 4 && !!info?.registered;

  // Move focus to the new step's heading when the step changes, so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (!cur) return;
    head.current?.focus({ preventScroll: first.current });
    first.current = false;
    setDnsTry(0); setPaused(false);
  }, [cur]);

  // DNS: once the owner has pressed "Verify domain" once, Shop's button reads "Check now". Press it every few seconds.
  useEffect(() => {
    if (at !== 2 || paused) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      const b = ref.current?.querySelector('li.step.current .row > button.btn');
      if (!b || b.disabled || !/check now/i.test(b.textContent)) return;
      setDnsTry((n) => { if (n >= DNS_MAX) return n; b.click(); return n + 1; });
    }, DNS_EVERY_MS);
    return () => clearInterval(id);
  }, [at, paused]);
  const polling = at === 2 && dnsTry > 0 && !paused && dnsTry < DNS_MAX;

  const copy = STEPS[at];
  const payout = info?.payout;
  return html`
    <div class="wiz" ref=${ref} data-step=${at + 1}>
      <div class="wiz-top">
        <p class="eyebrow">Set up payments for</p>
        <p class="wiz-host">${site.host}</p>
        <button type="button" class="link-btn wiz-change" onClick=${onChange}>Not your site? Change it</button>
      </div>

      <ol class="rail" aria-label="Setup progress">
        ${STEPS.map((st, i) => {
          const state = i === 0 ? 'done' : (steps[i - 1]?.state || 'todo');
          const sum = i === 0 ? site.host : steps[i - 1]?.sum;
          return html`<li class=${'rail-i ' + state} aria-current=${state === 'current' ? 'step' : null}>
            <span class="rail-bar" aria-hidden="true"></span>
            <span class="rail-l">${state === 'done' ? html`<${Icon} name="check" />` : html`<span class="rail-n" aria-hidden="true">${i + 1}</span>`}${st.label}</span>
            <span class="sr-only">, step ${i + 1} of 5, ${{ done: 'done', current: 'current step', todo: 'not started' }[state]}</span>
            ${state === 'done' && sum && html`<span class="rail-s">${sum}</span>`}
          </li>`;
        })}
      </ol>

      <div class=${'wiz-now' + (registered ? ' live' : '')}>
        ${registered
          ? html`<p class="wiz-count">Step 5 of 5, done</p>
              <h2 class="wiz-h" tabindex="-1" ref=${head}>${info.pending ? 'Your payout change is scheduled' : 'Your site is live'}</h2>
              <p class="wiz-why">${info.pending
                ? html`Payments for <strong>${site.host}</strong> keep going to <strong class="mono">${short(payout)}</strong> until the change goes live. The details are below.`
                : html`Payments for <strong>${site.host}</strong> go to <strong class="mono">${short(payout)}</strong>.`}${' '}Add the button below to start taking them.</p>
              <${DoneLinks} site=${site} />`
          : html`<p class="wiz-count">Step ${at + 1} of 5</p>
              <h2 class="wiz-h" tabindex="-1" ref=${head}>${copy.title}</h2>
              <p class="wiz-why">${copy.why}</p>`}
        <div class="wiz-status" role="status" aria-live="polite">
          ${at === 2 && polling && html`<span class="spin" aria-hidden="true"></span><span>Looking for the record every ${DNS_EVERY_MS / 1000} seconds (check ${dnsTry}).
            <button type="button" class="link-btn" onClick=${() => setPaused(true)}>Pause</button></span>`}
          ${at === 2 && paused && html`<span>Paused. Press Check now when the record is in place, or <button type="button" class="link-btn" onClick=${() => setPaused(false)}>check automatically</button>.</span>`}
          ${at === 2 && !paused && dnsTry >= DNS_MAX && html`<span>We stopped checking after ${DNS_MAX} tries. Press Check now when the record is in place.</span>`}
          ${at === 2 && !paused && dnsTry === 0 && html`<span>Press Verify domain once the record is saved. After that we keep checking for you.</span>`}
        </div>
      </div>
      ${children}
    </div>`;
}

function DoneLinks({ site }) {
  const jump = () => {
    const t = document.getElementById('test-checkout');
    if (!t) return;
    t.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    t.focus({ preventScroll: true });
  };
  return html`<nav class="done-links" aria-label="Next">
    <button type="button" class="btn ghost sm" onClick=${jump}>Test checkout</button>
    <a class="btn ghost sm" href="../receipt/">Receipt example</a>
    <a class="btn ghost sm" href="../pay/">Pay-link generator</a>
    <a class="btn ghost sm" href=${'../dashboard/index.html?site=' + encodeURIComponent(site.origin)}>Dashboard</a>
  </nav>`;
}

// Test checkout: the real button and frame, with an amount the owner picks. The frame always names the site
// the buyer is actually on (the browser reports it), so on this page it names this page's host, not the owner's site.
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
  return html`<div class="preview" id="test-checkout" tabindex="-1">
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
      Pasted on your site, the same button says <strong>Pay ${ok ? amount : '…'} USDT to ${site.host}</strong>.</p>
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
