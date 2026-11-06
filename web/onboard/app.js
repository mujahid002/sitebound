// Shop onboarding: wallet -> DNS proof -> register -> snippet.
import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { html, Brand, Icon, Spinner, Notice, CopyButton, TxLink, AddrLink, useTick, Empty } from './ui.js';
import {
  ABI, loadConfig, parseSite, contractState, readSite, secondsLeft, useWallet, errText,
  short, sameAddr, duration, durationWords, readText,
} from './lib.js';

const { ethers } = window;
const POLL_MS = 15000;
const POLL_MAX = 20;

// ---------------------------------------------------------------- relayer

async function post(cfg, path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await fetch(cfg.relayerUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { http: res.status, ok: res.ok, json: json || {} };
  } finally {
    clearTimeout(timer);
  }
}

const snippetFor = (origin) => `<script src="${origin}/button/sitebound.js"></script>

<sitebound-pay amount="12.00" order="A123"></sitebound-pay>

<script>
  document.addEventListener('sitebound:paid', (e) => {
    // e.detail is the receipt. Check it on your
    // server before you ship the goods.
    console.log('paid', e.detail);
  });
</script>`;

// ---------------------------------------------------------------- page

function App() {
  const [boot, setBoot] = useState({ status: 'loading' });
  useEffect(() => { loadConfig().then((r) => setBoot(r.error ? { status: 'error', error: r.error } : { status: 'ready', cfg: r.cfg })); }, []);

  const site = parseSite(new URLSearchParams(location.search).get('site'));
  let body;
  if (site.error) body = html`<${BadSite} site=${site} />`;
  else if (boot.status === 'loading') body = html`<p class="lede" role="status">Loading your shop setup…</p>`;
  else if (boot.status === 'error') {
    body = html`<${Empty} title=${boot.error === 'missing' ? 'Setup is not configured yet' : 'Setup config is incomplete'}>
      The site needs its <span class="mono">config.js</span> (chain, RPC, relayer and contract address). Come back once it has been deployed.<//>`;
  } else body = html`<${Shop} cfg=${boot.cfg} site=${site} />`;

  return html`
    <header class="bar"><${Brand} /></header>
    <main id="main" class="page">${body}</main>
    <footer class="foot">
      <p>Whitechain Sepolia testnet. Not audited.</p>
      <p>DNS ownership is checked by the Sitebound relayer, which is a trusted step in this version.</p>
    </footer>`;
}

function BadSite({ site }) {
  const msg = {
    none: 'Open this page from the Sitebound home page, or add ?site=https://your-shop.com to the address.',
    bad: 'That does not look like a web address. It needs to be the exact origin, like https://shop.com.',
    notorigin: `The site must be just the origin, with no path, slash or capitals${site.hint ? `. Try ${site.hint}` : ''}.`,
    https: 'Sitebound only works with https sites.',
  }[site.error];
  return html`<${Empty} title="We need your site first" action=${html`<a class="btn" href="../landing/index.html#site">Type your website</a>`}>${msg}<//>`;
}

// Also used inline by the landing page (web/landing/kit.js), which passes the optional props.
export function Shop({ cfg, site, onChangeSite, onInfo, snippetExtra }) {
  const wallet = useWallet(cfg);
  const { account } = wallet;
  const [chain, setChain] = useState({ status: 'loading' });
  const [dns, setDns] = useState({ state: 'idle' });
  const [nextAt, setNextAt] = useState(0);
  const [reg, setReg] = useState({ state: 'idle' });
  const latest = useRef({});
  latest.current = { account };
  const attempts = useRef(0);
  const busyDns = useRef(false);

  const refresh = useCallback(async () => {
    try {
      if ((await contractState(cfg)) === 'none') return setChain({ status: 'none' });
      return setChain({ status: 'ok', info: await readSite(cfg, site.siteHash) });
    } catch (e) {
      setChain({ status: 'error', message: readText(e) });
    }
  }, [cfg, site.siteHash]);
  useEffect(() => { refresh(); }, [refresh]);

  const info = chain.status === 'ok' ? chain.info : null;
  useEffect(() => { onInfo?.(info); }, [info]);
  const walletDone = !!account && wallet.onChain;
  const mine = info?.registered && (sameAddr(info.payout, account) || sameAddr(info.pending, account));
  const dnsOk = dns.state === 'ok' && sameAddr(dns.payout, account);

  // --- DNS check, with a slow automatic retry because TXT records take time to spread.
  const checkDns = useCallback(async () => {
    if (busyDns.current) return;
    busyDns.current = true;
    setNextAt(0);
    setDns((d) => ({ ...d, state: 'checking' }));
    attempts.current += 1;
    let next;
    try {
      const r = await post(cfg, '/dns/check', { site: site.origin });
      if (r.ok && r.json.ok) {
        next = { state: 'ok', payout: r.json.payout };
      } else if (r.http >= 500) {
        next = { state: 'unreachable' };
      } else {
        next = { state: 'fail', detail: typeof r.json.error === 'string' ? errText({ message: r.json.error }) : '' };
      }
    } catch {
      next = { state: 'unreachable' };
    }
    setDns(next);
    busyDns.current = false;
    const matched = next.state === 'ok' && sameAddr(next.payout, latest.current.account);
    if (!matched && attempts.current < POLL_MAX) setNextAt(Date.now() + POLL_MS);
  }, [cfg, site.origin]);

  useEffect(() => {
    if (!nextAt) return;
    const t = setTimeout(checkDns, Math.max(0, nextAt - Date.now()));
    return () => clearTimeout(t);
  }, [nextAt, checkDns]);
  useTick(1000, nextAt > 0);
  const manualCheck = () => { attempts.current = 0; checkDns(); };

  // --- Register through the relayer, then wait for the chain to show it.
  const register = async () => {
    setReg({ state: 'busy' });
    try {
      const r = await post(cfg, '/register', { site: site.origin, payout: account });
      const j = r.json;
      if (!r.ok || j.error) throw new Error(typeof j.error === 'string' ? j.error : `The relayer answered ${r.http}.`);
      const hash = [j.txHash, j.hash, j.tx].find((x) => typeof x === 'string' && /^0x[0-9a-fA-F]{64}$/.test(x));
      setReg({ state: 'done', hash, pendingAnswer: !!j.pending });
      for (let i = 0; i < 12; i++) {
        const fresh = await readSite(cfg, site.siteHash).catch(() => null);
        if (fresh?.registered && (sameAddr(fresh.payout, account) || sameAddr(fresh.pending, account))) break;
        await new Promise((res) => setTimeout(res, 2500));
      }
      await refresh();
    } catch (e) {
      setReg({ state: 'error', message: e.name === 'AbortError' ? 'The relayer took too long to answer.' : errText(e) });
    }
  };

  // --- Current step
  const dnsDone = dnsOk || (mine && !info.pending);
  const regDone = !!mine;
  const current = !walletDone ? 1 : !dnsDone && !regDone ? 2 : !regDone ? 3 : 4;
  const state = (n) => (n < current ? 'done' : n === current ? 'current' : 'todo');

  return html`
    <div class="head">
      <p class="eyebrow">Connect your shop</p>
      <h1 class="h1">${site.host}</h1>
      <p class="lede">Four short steps. Your checkout code never holds a payment address.</p>
      ${onChangeSite
        ? html`<button type="button" class="quiet-link link-btn" onClick=${onChangeSite}>Not your site? Change it</button>`
        : html`<a class="quiet-link" href="../landing/index.html#site">Not your site? Change it</a>`}
    </div>

    ${chain.status === 'none' && html`<${Notice} kind="warn" title="The Sitebound contract is not deployed yet">
      You can connect a wallet and check your DNS now. Registering opens once the contract is live.<//>`}
    ${chain.status === 'error' && html`<${Notice} kind="error" title="Could not read the chain">${chain.message}
      <div class="row"><button class="link-btn" onClick=${refresh}>Try again</button></div><//>`}
    ${info?.registered && html`<${SiteStatus} cfg=${cfg} site=${site} info=${info} wallet=${wallet} refresh=${refresh} />`}

    <ol class="stepper" aria-label="Setup steps">
      <${Step} n=${1} state=${state(1)} title="Connect your wallet"
        summary=${walletDone && html`<span class="mono">${short(account)}</span> on ${cfg.chainName}`}
        hint="This wallet receives your payments.">
        <${WalletStep} cfg=${cfg} wallet=${wallet} />
      <//>
      <${Step} n=${2} state=${state(2)} title="Add the DNS record"
        summary=${dnsDone && (dnsOk ? 'Record found' : 'Already verified on chain')}
        hint="Proves you own the domain.">
        <${DnsStep} cfg=${cfg} site=${site} account=${account} dns=${dns} dnsOk=${dnsOk} nextAt=${nextAt}
          onCheck=${manualCheck} onStop=${() => setNextAt(0)} attempts=${attempts.current} />
      <//>
      <${Step} n=${3} state=${state(3)} title=${info?.registered && !mine ? 'Change your payout wallet' : 'Register your shop'}
        summary=${regDone && (info.pending && sameAddr(info.pending, account) ? 'Payout change scheduled' : 'Registered')}
        hint="Saves your payout wallet on chain.">
        <${RegisterStep} cfg=${cfg} chain=${chain} reg=${reg} account=${account} onRegister=${register} />
      <//>
      <${Step} n=${4} state=${state(4)} title="Paste the snippet" hint="Three lines on your checkout page.">
        <${SnippetStep} cfg=${cfg} site=${site} extra=${snippetExtra} />
      <//>
    </ol>`;
}

// ---------------------------------------------------------------- step shell

function Step({ n, state, title, summary, hint, children }) {
  const label = { done: 'done', current: 'current step', todo: 'not started' }[state];
  return html`<li class=${'step ' + state} aria-current=${state === 'current' ? 'step' : null}>
    <span class="dot" aria-hidden="true">${state === 'done' ? html`<${Icon} name="check" />` : n}</span>
    <div class="step-main">
      <h2 class="step-title">${title}<span class="sr-only">, step ${n} of 4, ${label}</span></h2>
      ${state === 'done' && summary ? html`<p class="step-sum">${summary}</p>` : null}
      ${state === 'todo' ? html`<p class="step-sum">${hint}</p>` : null}
      ${state === 'current' ? html`<div class="step-body">${children}</div>` : null}
    </div>
  </li>`;
}

// ---------------------------------------------------------------- 1 wallet

function WalletStep({ cfg, wallet }) {
  if (!wallet.hasWallet) {
    return html`<${Notice} kind="warn" title="No wallet found in this browser">
      Install a browser wallet such as MetaMask or Rabby, or open this page inside your wallet app, then reload.<//>`;
  }
  const wrongChain = !!wallet.account && !wallet.onChain;
  return html`
    <p>Connect the wallet that should receive your money. Buyers pay <strong>USDT</strong> straight to it. Pick one you control and back up.</p>
    <div class="row">
      <button class="btn" onClick=${wallet.connect} disabled=${wallet.busy}>
        ${wallet.busy ? html`<${Spinner} />` : null}
        ${wallet.busy ? 'Waiting for your wallet…' : wrongChain ? `Switch to ${cfg.chainName}` : 'Connect wallet'}
      </button>
    </div>
    ${wallet.error && html`<p class="hint err" role="alert">${wallet.error}</p>`}
    <p class="hint">Adds ${cfg.chainName} (chain ${cfg.chainId}, gas token WBT) to your wallet if it is missing.</p>`;
}

// ---------------------------------------------------------------- 2 dns

function DnsStep({ cfg, site, account, dns, dnsOk, nextAt, onCheck, onStop, attempts }) {
  const name = `_sitebound.${site.hostname}`;
  const value = `sitebound=${account}`;
  const checking = dns.state === 'checking';
  const waiting = nextAt > 0;
  const wait = Math.max(0, Math.ceil((nextAt - Date.now()) / 1000));
  const found = dns.state === 'ok' && !dnsOk;
  return html`
    <p>Add one <strong>TXT</strong> record at the company that manages DNS for <strong>${site.hostname}</strong>.</p>
    <dl class="records">
      <div class="kv inline"><dt class="kv-label">Type</dt><dd class="kv-val">TXT</dd></div>
      <div class="kv"><div class="kv-top"><dt class="kv-label">Name</dt><${CopyButton} text=${name} what="record name" /></div><dd class="kv-val">${name}</dd></div>
      <div class="kv"><div class="kv-top"><dt class="kv-label">Value</dt><${CopyButton} text=${value} what="record value" /></div><dd class="kv-val">${value}</dd></div>
    </dl>
    <p class="hint">The value is your payout wallet. If your DNS provider adds the domain by itself, leave off the part after <span class="mono">_sitebound</span>. The bare domain and <span class="mono">www</span> count as separate sites.</p>

    <div class="row">
      <button class="btn" onClick=${onCheck} disabled=${checking}>
        ${checking ? html`<${Spinner} />` : null}${checking ? 'Checking DNS…' : dns.state === 'idle' ? 'Verify domain' : 'Check now'}
      </button>
      ${waiting && html`<button class="link-btn" onClick=${onStop}>Stop checking</button>`}
    </div>

    <div class="live" aria-live="polite">
      ${dns.state === 'fail' && html`<${Notice} kind="warn" title="We cannot see the record yet">
        ${dns.detail ? html`<p>${dns.detail}</p>` : null}
        <p>New DNS records can take a few minutes to spread, sometimes longer. Check the name and value for typos.</p><//>`}
      ${dns.state === 'unreachable' && html`<${Notice} kind="error" title="Could not reach the Sitebound relayer">
        Check your connection, then try again. Nothing was changed.<//>`}
      ${found && html`<${Notice} kind="error" title="The record names a different wallet">
        <p>Your DNS says <span class="mono">${short(dns.payout)}</span> but you connected <span class="mono">${short(account)}</span>.
        Change the record value to the one above, or switch wallets.</p><//>`}
      ${waiting && !checking && html`<p class="hint">Checking again in ${wait} s (try ${attempts} of ${POLL_MAX}).</p>`}
      ${!waiting && !checking && attempts >= POLL_MAX && !dnsOk && html`<p class="hint">We stopped checking automatically. Press Check now when the record is in place.</p>`}
    </div>`;
}

// ---------------------------------------------------------------- 3 register

function RegisterStep({ cfg, chain, reg, account, onRegister }) {
  const info = chain.status === 'ok' ? chain.info : null;
  const change = info?.registered && !sameAddr(info.payout, account);
  const frozen = info?.frozen && change;
  const blocked = chain.status !== 'ok' || frozen || !cfg.relayerUrl;
  const busy = reg.state === 'busy' || (reg.state === 'done' && !(info?.registered && (sameAddr(info.payout, account) || sameAddr(info.pending, account))));
  return html`
    ${change
      ? html`<${Notice} kind="warn" title="This site already has a payout wallet">
          <p>Buyers pay <span class="mono">${short(info.payout)}</span> today. A change to <span class="mono">${short(account)}</span> goes live only after
          <strong> ${durationWords(info.delay)}</strong>, and until then payments keep going to the current wallet.
          The current wallet can press <strong>Freeze</strong> any time to stop it.</p><//>`
      : html`<p>Saves <span class="mono">${short(account)}</span> as the wallet that gets paid for <strong>this site only</strong>. Sitebound's relayer sends the transaction and pays the gas, so there is nothing to sign.</p>`}
    ${frozen && html`<${Notice} kind="error" title="This site is frozen">The current payout wallet has to unfreeze it before a change can be requested.<//>`}
    ${!cfg.relayerUrl && html`<${Notice} kind="error" title="No relayer configured">Registration is not available in this build.<//>`}
    <div class="row">
      <button class="btn" onClick=${onRegister} disabled=${blocked || busy}>
        ${busy ? html`<${Spinner} />` : null}${busy ? 'Waiting for the chain…' : change ? 'Request payout change' : 'Register shop'}
      </button>
    </div>
    <div aria-live="polite">
      ${reg.state === 'error' && html`<${Notice} kind="error" title="Registration did not go through">${reg.message}<//>`}
      ${reg.state === 'done' && reg.hash && html`<p class="hint">Transaction sent: <${TxLink} cfg=${cfg} hash=${reg.hash} /></p>`}
      ${reg.state === 'done' && !reg.hash && html`<p class="hint">Transaction sent. Waiting for it to show on chain.</p>`}
    </div>`;
}

// ---------------------------------------------------------------- 4 snippet

function SnippetStep({ cfg, site, extra }) {
  const origin = cfg.frameOrigin || location.origin;
  const code = snippetFor(origin);
  return html`
    <p>Paste this where your checkout button goes. There is no address in it, and there never will be.</p>
    <div class="code-wrap">
      <div class="code-top"><span class="kv-label">HTML</span><${CopyButton} text=${code} label="Copy snippet" /></div>
      <pre class="code" tabindex="0" aria-label="Integration snippet"><code>${code}</code></pre>
    </div>
    <ul class="notes">
      <li>Every <span class="mono">order</span> must be unique per payment. The contract rejects an order id it has already seen for your site.</li>
      <li>Set <span class="mono">amount</span> and <span class="mono">order</span> on your server, not from anything a buyer can edit.</li>
    </ul>
    ${extra}
    <div class="row">
      <a class="btn" href=${'../dashboard/index.html?site=' + encodeURIComponent(site.origin)}>Open dashboard</a>
    </div>`;
}

// ---------------------------------------------------------------- registered status + freeze

function SiteStatus({ cfg, site, info, wallet, refresh }) {
  const [tx, setTx] = useState({ state: 'idle' });
  const pending = !!info.pending;
  useTick(1000, pending);
  const left = pending ? secondsLeft(info) : 0;
  const lastRefresh = useRef(0);
  useEffect(() => {
    if (pending && left <= 0 && Date.now() - lastRefresh.current > 8000) { lastRefresh.current = Date.now(); refresh(); }
  });
  const isPayout = sameAddr(wallet.account, info.payout);

  const run = async (fn) => {
    setTx({ state: 'sign' });
    try {
      const signer = await wallet.getSigner();
      const c = new ethers.Contract(cfg.address, ABI, signer);
      const sent = await c[fn](site.siteHash);
      setTx({ state: 'wait', hash: sent.hash });
      await sent.wait();
      setTx({ state: 'done', hash: sent.hash });
      await refresh();
    } catch (e) {
      setTx({ state: 'error', message: errText(e) });
    }
  };
  const working = tx.state === 'sign' || tx.state === 'wait';

  return html`<section class="status" aria-labelledby="status-h">
    <div class="status-top">
      <h2 id="status-h" class="status-h">Registered on Sitebound</h2>
      ${info.frozen ? html`<span class="badge err">Frozen</span>` : pending ? html`<span class="badge warn">Change pending</span>` : html`<span class="badge ok">Active</span>`}
    </div>
    <dl class="facts">
      <div><dt>Payout wallet</dt><dd><${AddrLink} cfg=${cfg} address=${info.payout} full=${true} /></dd></div>
      ${pending && html`<div><dt>Pending payout</dt><dd>
        <${AddrLink} cfg=${cfg} address=${info.pending} full=${true} />
        <span class="countdown">${left > 0 ? `goes live in ${duration(left)}` : 'going live now'}</span></dd></div>`}
    </dl>
    ${pending && html`<p class="hint">Until then buyers still pay the payout wallet above. If you did not ask for this change, press Freeze from the payout wallet.</p>`}
    ${info.frozen && html`<p class="hint">Payments to this site are stopped. Unfreeze to take payments again.</p>`}

    ${isPayout
      ? html`<div class="row">
          <button class=${'btn sm ' + (info.frozen ? '' : 'ghost danger')} onClick=${() => run(info.frozen ? 'unfreeze' : 'freeze')} disabled=${working}>
            ${working ? html`<${Spinner} />` : null}${working ? 'Working…' : info.frozen ? 'Unfreeze site' : 'Freeze site'}
          </button>
          ${!info.frozen && html`<span class="hint">Stops all payments and cancels any pending change.</span>`}
        </div>`
      : html`<p class="hint">${wallet.account ? 'Switch to the payout wallet to freeze or unfreeze.' : 'Connect the payout wallet in step 1 to freeze or unfreeze.'}</p>`}
    <div aria-live="polite">
      ${tx.state === 'wait' && html`<p class="hint">Waiting for confirmation: <${TxLink} cfg=${cfg} hash=${tx.hash} /></p>`}
      ${tx.state === 'done' && html`<p class="hint">Done: <${TxLink} cfg=${cfg} hash=${tx.hash} /></p>`}
      ${tx.state === 'error' && html`<p class="hint err" role="alert">${tx.message}</p>`}
    </div>
  </section>`;
}

// The landing page imports Shop from this module and has no #app, so only the onboarding page renders here.
const root = document.getElementById('app');
if (root) render(html`<${App} />`, root);
