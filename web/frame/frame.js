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

let pending = null, sendWin = null, setupWin = null, notSetUp = false;
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
$('fee').textContent = `+${C.relayerFee} USDT network fee, taken from your wallet. You need no gas.`;
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
  for (const id of ['pay', 'pay-wallet', 'continue']) $(id).disabled = on || !!problem || notSetUp;
}
const busy = (text) => (lock(true), say(text, { busy: true }));
const fail = (text, opts) => (lock(false), say(text, { err: true, ...opts }));

async function pay(mode) {
  const relayerFee = mode === 'relayer' ? units(C.relayerFee) : 0n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const configVersion = await versionP;
  versionP = readVersion().catch(() => null);
  if (configVersion == null) return fail('Could not read this website’s settings from Whitechain. Check your connection and try again.');
  const challenge = challengeOf({ chainId: C.chainId, address: C.address, siteHash, configVersion, orderId, amount, relayerFee, deadline });
  $('continue').hidden = true;
  busy('Waiting for Touch ID…');
  let cred;
  try {
    cred = await navigator.credentials.get({
      publicKey: { rpId: location.hostname, challenge: ethers.getBytes(challenge), userVerification: 'required', allowCredentials: [], timeout: 120_000 },
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') return fail(errText(e));
    $('pay').textContent = 'Try again';
    return fail('Touch ID was cancelled, or this device has no Sitebound passkey yet. Try again, or set up below.');
  }
  try {
    const r = cred.response;
    const clientDataJSON = new TextDecoder().decode(r.clientDataJSON);
    checkClientData(clientDataJSON, { challenge, frameOrigin: location.origin, topOrigin });
    const input = payInputOf({ rawId: cred.rawId, authenticatorData: r.authenticatorData, clientDataJSON, signature: r.signature, orderId, amount, relayerFee, deadline });
    const { wallet } = await new ethers.Contract(C.address, SITEBOUND_ABI, rpc).buyers(input.credentialHash);
    if (wallet === ethers.ZeroAddress) throw new Error('This passkey is not linked to a wallet yet. Choose “Set up” below.');
    if (mode === 'relayer') return await settle(await viaRelayer(input));
    if (window.ethereum) {
      busy('Confirm in your wallet…');
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
  let res;
  try {
    const req = quote ? { ...input, quoteExpiry: quote.expiry, quoteSig: quote.sig } : input;
    res = await fetch(`${C.relayerUrl}/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: jsonOf(req) });
  } catch {
    throw new Error('Could not reach the payment service. Try again, or choose “Pay from my wallet instead”.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash ?? '')) throw new Error(body.error || `The payment was refused (${res.status}). Try again, or choose “Pay from my wallet instead”.`);
  return body.txHash;
}

// Trust the chain, not whoever sent the transaction: the receipt must carry Paid for this order.
async function settle(txHash) {
  busy('Paying. This takes a few seconds.');
  try {
    const rc = await rpc.waitForTransaction(txHash, 1, 180_000);
    const paid = rc?.status === 1 && rc.logs.some((l) =>
      l.address.toLowerCase() === C.address.toLowerCase() && l.topics[0] === paidTopic() && l.topics[1] === paymentId);
    if (!paid) throw new Error('That transaction did not pay this order.');
  } catch (e) {
    return fail(errText(e), { tx: txHash });
  }
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

const close = () => parentOrigin && parent.postMessage({ type: 'sitebound:close' }, parentOrigin);

$('pay').onclick = () => pay('relayer');
$('pay-wallet').onclick = () => pay('wallet');
$('close').onclick = $('done').onclick = close;
addEventListener('keydown', (e) => e.key === 'Escape' && close());

$('continue').onclick = () => {
  sendWin = open('send.html', 'sitebound-send', 'popup,width=440,height=600');
  if (!sendWin) return fail('Your browser blocked the wallet window. Allow pop-ups for this checkout, then try again.');
  busy('Finish in the wallet window…');
  const w = sendWin;
  const watch = setInterval(() => {
    if (!w.closed) return;
    clearInterval(watch);
    if (sendWin === w) fail('The wallet window closed before paying. Try again.');
  }, 500);
};
$('setup').onclick = (e) => {
  setupWin = open('setup.html', 'sitebound-setup', 'popup,width=460,height=760');
  if (setupWin) e.preventDefault();
};

addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data) return;
  const d = e.data;
  if (e.source === setupWin && d.type === 'sitebound:setup-done') {
    $('pay').textContent = 'Pay with Touch ID';
    lock(false);
    if (!notSetUp) say('Setup complete. Pay with Touch ID.');
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
