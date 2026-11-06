import { units, siteHashOf, orderIdOf, paymentIdOf, paidTopic, challengeOf, checkClientData, payInputOf, jsonOf, errText, SITEBOUND_ABI } from './lib.js';
import { sendPay, notDeployed } from './wallet.js';

const C = window.SITEBOUND;
const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const amountText = q.get('amount') ?? '';
const order = q.get('order') ?? '';
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
  : !topOrigin ? 'Your browser does not say which site opened this checkout.'
  : notDeployed();

let pending = null, sendWin = null, setupWin = null;

$('amount').textContent = $('line-amount').textContent = validAmount ? amountText : '—';
$('site').textContent = site;
$('order').textContent = order && `Order ${order}`;
$('fee').textContent = `Adds a ${C.relayerFee} USDT relayer fee, so you need no gas.`;
if (!ao || ao.length !== 1) {
  $('warn').hidden = false;
  $('warn').textContent = ao?.length > 1
    ? `This checkout is nested inside another frame. It pays ${site}, the site in your address bar.`
    : `Your browser does not report the page around this checkout. The payment only goes through if it is ${site}.`;
}

function say(text, { err = false, tx = null } = {}) {
  const m = $('msg');
  m.className = err ? 'msg err' : 'msg';
  m.textContent = text;
  if (tx) m.append(' ', Object.assign(document.createElement('a'), { className: 'link', href: `${C.explorer}/tx/${tx}`, target: '_blank', rel: 'noopener', textContent: 'View transaction' }));
}
function lock(on) {
  for (const id of ['pay', 'pay-wallet', 'continue']) $(id).disabled = on || !!problem;
}
const busy = (text) => (lock(true), say(text));
const fail = (text, opts) => (lock(false), say(text, { err: true, ...opts }));

async function pay(mode) {
  const relayerFee = mode === 'relayer' ? units(C.relayerFee) : 0n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const challenge = challengeOf({ chainId: C.chainId, address: C.address, siteHash, orderId, amount, relayerFee, deadline });
  $('continue').hidden = true;
  busy('Confirm with your passkey…');
  let cred;
  try {
    cred = await navigator.credentials.get({
      publicKey: { rpId: location.hostname, challenge: ethers.getBytes(challenge), userVerification: 'required', allowCredentials: [], timeout: 120_000 },
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') return fail(errText(e));
    $('pay').textContent = 'Pay again';
    return fail('Cancelled, or there is no Sitebound passkey on this device yet.');
  }
  try {
    const r = cred.response;
    const clientDataJSON = new TextDecoder().decode(r.clientDataJSON);
    checkClientData(clientDataJSON, { challenge, frameOrigin: location.origin, topOrigin });
    const input = payInputOf({ rawId: cred.rawId, authenticatorData: r.authenticatorData, clientDataJSON, signature: r.signature, orderId, amount, relayerFee, deadline });
    const { wallet } = await new ethers.Contract(C.address, SITEBOUND_ABI, rpc).buyers(input.credentialHash);
    if (wallet === ethers.ZeroAddress) throw new Error('This passkey is not linked to a wallet yet. Use “Set up” below.');
    if (mode === 'relayer') return await settle(await viaRelayer(input));
    if (window.ethereum) {
      busy('Confirm in your wallet…');
      return await settle(await sendPay(window.ethereum, input));
    }
    // No wallet inside this cross-origin frame: a top-level popup on our origin sends the signed input.
    pending = input;
    lock(false);
    $('continue').hidden = false;
    say('Passkey confirmed. Your wallet opens in a new window.');
  } catch (e) {
    fail(errText(e));
  }
}

async function viaRelayer(input) {
  busy('Sending…');
  let res;
  try {
    res = await fetch(`${C.relayerUrl}/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: jsonOf(input) });
  } catch {
    throw new Error('The relayer is unreachable. Try “Pay from my wallet”.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash ?? '')) throw new Error(body.error || `The relayer refused (${res.status}). Try “Pay from my wallet”.`);
  return body.txHash;
}

// Trust the chain, not whoever sent the transaction: the receipt must carry Paid for this order.
async function settle(txHash) {
  busy('Confirming on Whitechain…');
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
  if (!sendWin) return fail('Allow pop-ups for this checkout, then try again.');
  busy('Finish in the wallet window…');
  const w = sendWin;
  const watch = setInterval(() => {
    if (!w.closed) return;
    clearInterval(watch);
    if (sendWin === w) fail('The wallet window closed before paying.');
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
    $('pay').textContent = 'Pay with passkey';
    lock(false);
    say('Setup complete. Pay with your passkey.');
  }
  if (e.source !== sendWin) return;
  if (d.type === 'sitebound:send-ready') sendWin.postMessage({ type: 'sitebound:send', input: jsonOf(pending), site, amount: amountText }, location.origin);
  if (d.type === 'sitebound:sent') {
    sendWin = null;
    $('continue').hidden = true;
    settle(d.txHash);
  }
  if (d.type === 'sitebound:send-error') fail(d.error);
});

lock(false);
if (problem) say(problem, { err: true });
