// First-time setup, top-level on the frame origin (a popup from the checkout frame):
// wallet connect -> passkey -> permit + Bind signatures -> relayer (or the wallet) puts them on-chain.
import { units, credentialHashOf, pubKeyXY, jsonOf, errText, BIND_TYPES, PERMIT_TYPES, bindDomain, permitDomain, SITEBOUND_ABI, TOKEN_ABI } from './lib.js';
import { connect, notDeployed, choose, cancelled } from './wallet.js';

const C = window.SITEBOUND;
const $ = (id) => document.getElementById(id);
const now = () => Math.floor(Date.now() / 1000);
let signer, account, passkey, signed;

const step = (k, s) => (document.querySelector(`[data-k="${k}"]`).dataset.s = s);
function say(text, err = false) {
  $('msg').className = err ? 'msg err' : 'msg';
  $('msg').textContent = text;
}

// Pick a wallet (EIP-6963 chooser), then switch it to the right chain. Opens on page load and from the buttons.
async function pick() {
  $('connect').disabled = $('change').disabled = true;
  say('');
  try {
    const { provider, info } = await choose();
    say(`Check ${info.name} to switch network…`);
    signer = await connect(provider);
    account = await signer.getAddress();
    $('wallet-name').textContent = info.name;
    $('account').textContent = `${account.slice(0, 6)}…${account.slice(-4)}`;
    $('s-connect').hidden = true;
    $('s-caps').hidden = false;
    say('');
  } catch (e) {
    say(cancelled(e) ? '' : errText(e), !cancelled(e));
  } finally {
    $('connect').disabled = $('change').disabled = false;
  }
}
$('connect').onclick = pick;
$('change').onclick = pick;

async function createPasskey() {
  const who = `Sitebound ${account.slice(0, 6)}…${account.slice(-4)}`;
  const c = await navigator.credentials.create({
    publicKey: {
      rp: { id: location.hostname, name: 'Sitebound' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: who, displayName: who },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      timeout: 120_000,
    },
  });
  const { x, y } = pubKeyXY(c.response.getPublicKey());
  return { credentialHash: credentialHashOf(c.rawId), x, y };
}

function readCaps() {
  const days = Number($('days').value);
  let perPayCap, totalCap;
  try {
    perPayCap = units($('perPay').value.trim());
    totalCap = units($('total').value.trim());
  } catch {
    throw new Error('Enter limits like 50 or 12.5.');
  }
  if (perPayCap <= 0n || totalCap < perPayCap) throw new Error('The total must be at least the per-payment limit.');
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Expiry must be 1 to 365 days.');
  return { perPayCap, totalCap, expiry: BigInt(now() + days * 86400) };
}

$('s-caps').onsubmit = async (e) => {
  e.preventDefault();
  let k = 'caps';
  try {
    const blocked = notDeployed();
    if (blocked) throw new Error(blocked);
    const { perPayCap, totalCap, expiry } = readCaps();
    $('go').disabled = $('change').disabled = true;
    $('steps').hidden = false;
    say('');

    step((k = 'passkey'), 'doing');
    passkey ??= await createPasskey(); // kept across retries: another Touch ID would leave an unbound passkey behind
    step(k, 'done');

    step((k = 'permit'), 'doing');
    const token = new ethers.Contract(C.token, TOKEN_ABI, signer);
    const permit = { owner: account, spender: C.address, value: totalCap, nonce: await token.nonces(account), deadline: BigInt(now() + 3600) };
    const ps = ethers.Signature.from(await signer.signTypedData(permitDomain(C), PERMIT_TYPES, permit));
    step(k, 'done');

    step((k = 'bind'), 'doing');
    const sb = new ethers.Contract(C.address, SITEBOUND_ABI, signer);
    const bind = { credentialHash: passkey.credentialHash, pubX: passkey.x, pubY: passkey.y, perPayCap, totalCap, expiry, nonce: await sb.bindNonce(account) };
    const bs = ethers.Signature.from(await signer.signTypedData(bindDomain(C), BIND_TYPES, bind));
    step(k, 'done');

    signed = { permit: { ...permit, v: ps.v, r: ps.r, s: ps.s }, bind: { ...bind, wallet: account, v: bs.v, r: bs.r, s: bs.s } };
    step((k = 'submit'), 'doing');
    say('Saving. This takes a few seconds.');
    await confirmBound(await viaRelayer(signed));
    finished();
  } catch (e) {
    if (k !== 'caps') step(k, 'error');
    $('go').disabled = $('change').disabled = false;
    $('self').hidden = k !== 'submit';
    say(errText(e), true);
  }
};

async function viaRelayer(body) {
  let res;
  try {
    res = await fetch(`${C.relayerUrl}/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: jsonOf(body) });
  } catch {
    throw new Error('The relayer is unreachable.');
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !/^0x[0-9a-fA-F]{64}$/.test(out.txHash ?? '')) throw new Error(out.error || `The relayer refused (${res.status}).`);
  return out.txHash;
}

// Done only when the chain says this passkey is bound to this wallet.
async function confirmBound(txHash) {
  const rpc = new ethers.JsonRpcProvider(C.rpcUrl, C.chainId, { staticNetwork: true });
  try {
    const rc = await rpc.waitForTransaction(txHash, 1, 180_000);
    const { wallet } = await new ethers.Contract(C.address, SITEBOUND_ABI, rpc).buyers(passkey.credentialHash);
    if (rc?.status !== 1 || wallet.toLowerCase() !== account.toLowerCase()) throw new Error('The binding did not land on-chain.');
  } finally {
    rpc.destroy();
  }
}

$('self').onclick = async () => {
  const { permit: p, bind: b } = signed;
  $('self').disabled = true;
  step('submit', 'doing');
  try {
    const token = new ethers.Contract(C.token, TOKEN_ABI, signer);
    if ((await token.allowance(account, C.address)) < p.value) {
      say('Confirm the allowance in your wallet…');
      await (await token.permit(p.owner, p.spender, p.value, p.deadline, p.v, p.r, p.s)).wait();
    }
    say('Confirm the binding in your wallet…');
    const sb = new ethers.Contract(C.address, SITEBOUND_ABI, signer);
    const tx = await sb.bind(b.credentialHash, b.pubX, b.pubY, b.perPayCap, b.totalCap, b.expiry, b.wallet, b.v, b.r, b.s);
    await confirmBound(tx.hash);
    finished();
  } catch (e) {
    step('submit', 'error');
    say(errText(e), true);
  } finally {
    $('self').disabled = false;
  }
};

function finished() {
  step('submit', 'done');
  $('s-caps').hidden = $('self').hidden = true;
  $('finish').hidden = false;
  say('Done. From now on each payment is one Touch ID.');
  opener?.postMessage({ type: 'sitebound:setup-done' }, location.origin);
}
$('finish').onclick = () => close();
pick();
