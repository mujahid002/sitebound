// Sitebound merchant helper: sign quotes and verify payments. Runs on your server (Node with ethers v6) or in a page
// that has loaded the ethers v6 UMD build (window.ethers) first.
//
//   npm install ethers@6     # then copy this file next to your server code
//   import { signQuote, verifyPayment } from './sitebound-merchant.mjs';
//
// Never ship on the browser's `sitebound:paid` event alone: any script on the page can fire it. Ask the chain.
const E = globalThis.ethers ?? (await import('ethers'));

const PAYMENTS_ABI = ['function payments(bytes32) view returns (address wallet, bytes32 siteHash, uint256 amount, uint256 refunded)'];
const QUOTE_TYPES = {
  Quote: [
    { name: 'siteHash', type: 'bytes32' },
    { name: 'orderId', type: 'bytes32' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
};

// The frame's encodings (web/frame/lib.js): an order id of 1-31 printable ASCII characters is stored as bytes32 text,
// anything else as its keccak256. `site` is the shop's origin exactly as the browser reports it: "https://shop.example".
export const siteHashOf = (site) => E.keccak256(E.toUtf8Bytes(site));
export const orderIdOf = (order) => (/^[\x20-\x7e]{1,31}$/.test(order) ? E.encodeBytes32String(order) : E.id(order));
export const paymentIdOf = (site, order) =>
  E.keccak256(E.AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [siteHashOf(site), orderIdOf(order)]));
const units = (amount) => (typeof amount === 'bigint' ? amount : E.parseUnits(String(amount), 6));

/**
 * The value for <sitebound-pay quote="...">, for a site whose owner set a quote signer (setQuoteSigner).
 * `signer` is an ethers Signer holding the quote key, e.g. new Wallet(process.env.SITEBOUND_QUOTE_KEY).
 * `amount` is the same USDT text as the button's amount attribute ("12.00"), or base units as a bigint.
 * The contract refuses the payment if the page changes the amount or order, or after `expiry` (default now + 15 min).
 */
export async function signQuote(signer, { chainId, contract, token, site, order, amount, expiry }) {
  const exp = expiry ?? Math.floor(Date.now() / 1000) + 900;
  const sig = await signer.signTypedData(
    { name: 'Sitebound', version: '1', chainId, verifyingContract: contract },
    QUOTE_TYPES,
    { siteHash: siteHashOf(site), orderId: orderIdOf(order), token, amount: units(amount), expiry: exp },
  );
  return `${exp}.${sig}`;
}

/**
 * Reads payments(paymentId) on chain and checks it is `orderId` on `expectedSite`, paid `expectedAmount` USDT, and
 * nothing refunded. The id is recomputed from site and order, so a paymentId from the browser is only compared.
 * Pass `provider` (an ethers provider) or `rpcUrl`. Reads the latest block: how final that is on your chain is up
 * to you (wait for a confirmation count before shipping something valuable).
 * Returns { ok, reason, paymentId, wallet, amount, refunded }.
 */
export async function verifyPayment({ provider, rpcUrl, contract, expectedSite, expectedAmount, orderId, paymentId }) {
  const id = paymentIdOf(expectedSite, orderId);
  const out = { ok: false, reason: '', paymentId: id, wallet: E.ZeroAddress, amount: 0n, refunded: 0n };
  if (paymentId != null && String(paymentId).toLowerCase() !== id) return { ...out, reason: 'paymentId is not this site and order' };
  const pm = await new E.Contract(contract, PAYMENTS_ABI, provider ?? new E.JsonRpcProvider(rpcUrl)).payments(id);
  Object.assign(out, { wallet: pm.wallet, amount: pm.amount, refunded: pm.refunded });
  if (pm.wallet === E.ZeroAddress) return { ...out, reason: 'no payment for this order' };
  if (pm.siteHash !== siteHashOf(expectedSite)) return { ...out, reason: 'paid to another site' };
  if (pm.amount !== units(expectedAmount)) return { ...out, reason: `paid ${E.formatUnits(pm.amount, 6)} USDT, expected ${E.formatUnits(units(expectedAmount), 6)}` };
  if (pm.refunded > 0n) return { ...out, reason: `${E.formatUnits(pm.refunded, 6)} USDT refunded` };
  return { ...out, ok: true };
}
