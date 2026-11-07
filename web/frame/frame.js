import { units, siteHashOf, orderIdOf, paymentIdOf, paidTopic, challengeOf, quoteOf, checkClientData, payInputOf, jsonOf, errText, SITEBOUND_ABI } from './lib.js';
import { sendPay, notDeployed } from './wallet.js';

const C = window.SITEBOUND;
const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const amountText = q.get('amount') ?? '';
const order = q.get('order') ?? '';
const quote = q.has('quote') ? quoteOf(q.get('quote')) : null;
const rpc = new ethers.JsonRpcProvider(C.rpcUrl, C.chainId, { staticNetwork: true });

// Chrome and Safari expose ancestorOrigins; Firefox does not, so fall back to the referrer.
// Neither is trusted: the contract pays the topOrigin the browser wrote into the signed
// clientDataJSON, so a wrong guess here only makes the payment fail, never sends it elsewhere.
const ao = location.ancestorOrigins;
const parentOrigin = ao?.length ? ao[0] : document.referrer ? new URL(document.referrer).origin : null;
const topOrigin = ao?.length ? ao[ao.length - 1] : parentOrigin;
const site = topOrigin?.replace(/^https:\/\//, '') ?? 'unknown site';

const validAmount = /^\d{1,12}(\.\d{1,6})?$/.test(amountText) && units(amountText) > 0n;
const amount = validAmount ? units(amountText) : 0n;
const orderId = orderIdOf(order);
const siteHash = topOrigin ? siteHashOf(topOrigin) : null;
const paymentId = siteHash && paymentIdOf(siteHash, orderId);
const problem =
  window.top === window ? 'Open this checkout from a website.'
  : !validAmount ? 'This checkout has an invalid amount.'
  : !order ? 'This checkout has no order id.'
  : q.has('quote') && !quote ? 'This checkout has an invalid quote.'
  : !topOrigin ? 'Your browser does not say which site opened this checkout.'
  : notDeployed();

let pending = null, sendWin = null, setupWin = null, setupViaLink = false, notSetUp = false;

// Has this browser finished Touch ID setup for the checkout? Storage can throw in a third-party iframe, so the
// answer is also kept in memory. It only picks the button and the wording; the contract is what checks the passkey.
const FLAG = 'sitebound.passkeySetup.v1';
let known = false;
try { known = localStorage.getItem(FLAG) === '1'; } catch {}
function setKnown(on) {
  known = on;
  try { on ? localStorage.setItem(FLAG, '1') : localStorage.removeItem(FLAG); } catch {}
  syncPay();
}
function syncPay() {
  $('pay').textContent = 'Confirm payment';
  $('have').hidden = known || !!problem;
}
// Set while a signed payment may be on its way to the chain: closing then would hide the result from the shop.
let paying = false;
// The site's config version is part of what the passkey signs. Read it ahead of the click, so nothing slow sits
// between the click and the passkey prompt; read it again after each attempt in case the site changed.
const readVersion = () => (siteHash && !problem ? new ethers.Contract(C.address, SITEBOUND_ABI, rpc).configVersion(siteHash) : Promise.resolve(null));
let versionP = readVersion().catch(() => null);
// A site with no payout in the registry can only fail after Touch ID ("site not registered"), so look first.
// Any failure or a slow RPC lets the checkout carry on as before: the contract still refuses an unregistered site.
const registryP = siteHash && !problem
  ? Promise.race([
      new ethers.Contract(C.address, SITEBOUND_ABI, rpc).sites(siteHash).then((st) => st.payout === ethers.ZeroAddress),
      new Promise((done) => setTimeout(done, 5000, false)),
    ]).catch(() => false)
  : Promise.resolve(false);

$('amount').textContent = $('line-amount').textContent = validAmount ? amountText : '—';
$('site').textContent = site;
$('order').textContent = order && `Order ${order}`;
if (!ao || ao.length !== 1) {
  $('warn').hidden = false;
  $('warn').textContent = ao?.length > 1
    ? `This checkout is nested inside another frame. It pays ${site}, the site in your address bar.`
    : `Your browser does not report the page around this checkout. The payment only goes through if it is ${site}.`;
}

function say(text, { err = false, tx = null, busy = false } = {}) {
  const m = $('msg');
  m.className = err ? 'msg err' : busy ? 'msg busy' : 'msg';
  m.textContent = text;
  if (tx) m.append(' ', Object.assign(document.createElement('a'), { className: 'link', href: `${C.explorer}/tx/${tx}`, target: '_blank', rel: 'noopener', textContent: 'View transaction' }));
}
function lock(on) {
  for (const id of ['pay', 'pay-wallet', 'continue', 'have']) $(id).disabled = on || !!problem || notSetUp;
}
const busy = (text) => (lock(true), say(text, { busy: true }));
const fail = (text, opts) => (paying = false, lock(false), say(text, { err: true, ...opts }));
const needSetup = (text) => (setKnown(false), fail(text));

async function pay(mode) {
  const relayerFee = mode === 'relayer' ? units(C.relayerFee) : 0n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  lock(true); // the settings read can be slow: a second click must not start a second Touch ID prompt
  const configVersion = await versionP;
  versionP = readVersion().catch(() => null);
  if (configVersion == null) return fail('Could not read this website’s settings from Whitechain. Check your connection and try again.');
  const challenge = challengeOf({ chainId: C.chainId, address: C.address, siteHash, configVersion, orderId, amount, relayerFee, deadline });
  $('continue').hidden = $('setup').hidden = true;
  busy('Waiting for Touch ID…');
  let cred;
  try {
    cred = await navigator.credentials.get({
      publicKey: { rpId: location.hostname, challenge: ethers.getBytes(challenge), userVerification: 'required', allowCredentials: [], timeout: 120_000 },
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') return fail(errText(e));
    // The browser gives the same error for a cancelled prompt and for no passkey on this device. Without the
    // setup flag the buyer never finished setup here; with it, the likely case is a cancel.
    if (!known) return needSetup('This device has no Sitebound passkey. Set up again.');
    Object.assign($('setup'), { hidden: false, textContent: 'Not working? Set up Touch ID again' });
    return fail('Touch ID cancelled. Try again.');
  }
  try {
    const r = cred.response;
    const clientDataJSON = new TextDecoder().decode(r.clientDataJSON);
    checkClientData(clientDataJSON, { challenge, frameOrigin: location.origin, topOrigin });
    const input = payInputOf({ rawId: cred.rawId, authenticatorData: r.authenticatorData, clientDataJSON, signature: r.signature, orderId, amount, relayerFee, deadline });
    const b = await new ethers.Contract(C.address, SITEBOUND_ABI, rpc).buyers(input.credentialHash);
    if (b.wallet === ethers.ZeroAddress) return needSetup('This Touch ID is not linked to Sitebound yet. Set up again.');
    // The contract checks the same limits, counting the fee, but only after the transaction is sent.
    const total = amount + relayerFee, usdt = (v) => ethers.formatUnits(v, 6);
    if (BigInt(Math.floor(Date.now() / 1000)) > b.expiry) throw new Error('Your Sitebound setup has expired. Use “Not working? Set up Touch ID again” to renew it.');
    if (total > b.perPayCap) throw new Error(`This payment with its fee is ${usdt(total)} USDT, over your limit of ${usdt(b.perPayCap)} USDT per payment. Use “Not working? Set up Touch ID again” to raise it.`);
    if (b.spent + total > b.totalCap) throw new Error(`This payment with its fee is ${usdt(total)} USDT, but only ${usdt(b.totalCap - b.spent)} USDT of your total limit is left. Use “Not working? Set up Touch ID again” to raise it.`);
    setKnown(true);
    if (mode === 'relayer') return await settle(await viaRelayer(input));
    if (window.ethereum) {
      busy('Confirm in your wallet…');
      paying = true;
      return await settle(await sendPay(window.ethereum, input, quote));
    }
    // No wallet inside this cross-origin frame: a top-level popup on our origin sends the signed input.
    pending = input;
    lock(false);
    $('continue').hidden = false;
    say('Touch ID confirmed. Your wallet opens in a new window.');
  } catch (e) {
    fail(errText(e));
  }
}

async function viaRelayer(input) {
  busy('Paying. This takes a few seconds.');
  paying = true;
  let res;
  try {
    const req = quote ? { ...input, quoteExpiry: quote.expiry, quoteSig: quote.sig } : input;
    res = await fetch(`${C.relayerUrl}/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: jsonOf(req), signal: AbortSignal.timeout(90_000) });
  } catch {
    throw new Error('Could not reach the payment service. Try again, or choose “Use a crypto wallet instead”.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash ?? '')) throw new Error(body.error || `The payment was refused (${res.status}). Try again, or choose “Use a crypto wallet instead”.`);
  return body.txHash;
}

// Trust the chain, not whoever sent the transaction: the receipt must carry Paid for this order.
async function settle(txHash) {
  busy('Paying. This takes a few seconds.');
  paying = true;
  try {
    const rc = await rpc.waitForTransaction(txHash, 1, 180_000);
    const paid = rc?.status === 1 && rc.logs.some((l) =>
      l.address.toLowerCase() === C.address.toLowerCase() && l.topics[0] === paidTopic() && l.topics[1] === paymentId);
    if (!paid) throw new Error('That transaction did not pay this order.');
  } catch (e) {
    return fail(errText(e), { tx: txHash });
  }
  paying = false;
  setKnown(true);
  for (const id of ['checkout', 'actions', 'warn']) $(id).hidden = true;
  $('receipt').hidden = false;
  $('r-amount').textContent = `${amountText} USDT`;
  $('r-site').textContent = site;
  $('r-order').textContent = order;
  $('r-receipt').href = new URL(`../receipt/?tx=${txHash}`, location.href).href;
  Object.assign($('r-tx'), { href: `${C.explorer}/tx/${txHash}`, textContent: `${txHash.slice(0, 10)}…${txHash.slice(-6)}` });
  $('done').focus();
  parent.postMessage({ type: 'sitebound:paid', orderId: order, txHash, paymentId }, parentOrigin);
}

const close = () => !paying && parentOrigin && parent.postMessage({ type: 'sitebound:close' }, parentOrigin);

// First visit: the click itself opens setup, so the browser allows the pop-up. Never await before window.open.
$('pay').onclick = () => (known ? pay('relayer') : openSetup());
$('have').onclick = () => pay('relayer');
$('pay-wallet').onclick = () => pay('wallet');
$('close').onclick = $('done').onclick = close;
addEventListener('keydown', (e) => e.key === 'Escape' && close());

$('continue').onclick = () => {
  sendWin = open('send.html', 'sitebound-send', 'popup,width=440,height=600');
  if (!sendWin) return fail('Your browser blocked the wallet window. Allow pop-ups for this checkout, then try again.');
  busy('Finish in the wallet window…');
  paying = true;
  const w = sendWin;
  const watch = setInterval(() => {
    if (!w.closed) return;
    clearInterval(watch);
    if (sendWin === w) fail('The wallet window closed before paying. Try again.');
  }, 500);
};
function openSetup() {
  setupWin = open('setup.html', 'sitebound-setup', 'popup,width=460,height=760');
  if (!setupWin) {
    Object.assign($('setup'), { hidden: false, textContent: 'Set up Touch ID' });
    fail('Your browser blocked the setup window.');
    return false;
  }
  busy('Finish setup in the new window');
  const w = setupWin;
  const watch = setInterval(() => {
    if (!w.closed) return;
    clearInterval(watch);
    if (setupWin === w && !known) (lock(false), say('The setup window closed before it finished.'));
  }, 500);
  return true;
}
// The fallback link opens setup in a tab we hold no handle to; setup-done from our own origin still counts.
$('setup').onclick = (e) => {
  setupViaLink = !openSetup();
  if (!setupViaLink) e.preventDefault();
};

addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data) return;
  const d = e.data;
  // From the setup popup, or from the setup tab the link opens when pop-ups are blocked: both are our own origin.
  if (d.type === 'sitebound:setup-done') {
    setKnown(true);
    $('setup').hidden = true;
    lock(false);
    if (!notSetUp) say('Setup done. Confirm with Touch ID.');
  }
  if (e.source !== sendWin) return;
  if (d.type === 'sitebound:send-ready') sendWin.postMessage({ type: 'sitebound:send', input: jsonOf(pending), quote: quote && { expiry: String(quote.expiry), sig: quote.sig }, site, amount: amountText }, location.origin);
  if (d.type === 'sitebound:sent') {
    sendWin = null;
    $('continue').hidden = true;
    settle(d.txHash);
  }
  if (d.type === 'sitebound:send-error') fail(d.error);
});

syncPay();
if (problem) {
  lock(false);
  say(problem, { err: true });
} else {
  busy('Checking this website…');
  registryP.then((none) => {
    notSetUp = none;
    lock(false);
    if (none) say('This site is not set up for Sitebound payments yet, so nothing was charged.', { err: true });
    else say('');
  });
}
