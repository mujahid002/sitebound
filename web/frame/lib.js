// Pure helpers shared by the frame, the setup popup and the checks in web/dev/.
// `ethers` is the vendored UMD global, read at call time so Node tests can set it first.
const E = () => globalThis.ethers;
const abi = () => E().AbiCoder.defaultAbiCoder();

export const SITEBOUND_ABI = [
  'function pay((bytes32 credentialHash,bytes authenticatorData,string clientDataJSON,uint256 typeIdx,uint256 challengeIdx,uint256 originIdx,uint256 crossOriginIdx,uint256 topOriginIdx,uint256 r,uint256 s,bytes32 orderId,uint256 amount,uint256 relayerFee,uint256 deadline) p) returns (bytes32)',
  'function payWithQuote((bytes32 credentialHash,bytes authenticatorData,string clientDataJSON,uint256 typeIdx,uint256 challengeIdx,uint256 originIdx,uint256 crossOriginIdx,uint256 topOriginIdx,uint256 r,uint256 s,bytes32 orderId,uint256 amount,uint256 relayerFee,uint256 deadline) p,uint64 quoteExpiry,bytes quoteSig) returns (bytes32)',
  'function configVersion(bytes32) view returns (uint256)',
  'function sites(bytes32) view returns (address payout,address pendingPayout,uint64 activeAt,bool frozen,uint256 nonce)',
  'function bind(bytes32 credentialHash,uint256 pubX,uint256 pubY,uint256 perPayCap,uint256 totalCap,uint64 expiry,address wallet,uint8 v,bytes32 r,bytes32 s)',
  'function bindNonce(address) view returns (uint256)',
  'function buyers(bytes32) view returns (address wallet,uint256 pubX,uint256 pubY,uint256 perPayCap,uint256 totalCap,uint256 spent,uint64 expiry)',
];
export const TOKEN_ABI = [
  'function nonces(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
];
export const BIND_TYPES = {
  Bind: [
    { name: 'credentialHash', type: 'bytes32' },
    { name: 'pubX', type: 'uint256' },
    { name: 'pubY', type: 'uint256' },
    { name: 'perPayCap', type: 'uint256' },
    { name: 'totalCap', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
};
export const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};
export const bindDomain = (c) => ({ name: 'Sitebound', version: '1', chainId: c.chainId, verifyingContract: c.address });
export const permitDomain = (c) => ({ name: 'Tether USD', version: '1', chainId: c.chainId, verifyingContract: c.token });

export const units = (s) => E().parseUnits(String(s), 6);
export const usdt = (v) => E().formatUnits(v, 6).replace(/\.0$/, '');
export const bytes = (b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : E().getBytes(b));

export const siteHashOf = (origin) => E().keccak256(E().toUtf8Bytes(origin));
// Short printable-ASCII orders are stored as text so the dashboard can show them; longer ones are hashed.
export const orderIdOf = (order) => (/^[\x20-\x7e]{1,31}$/.test(order) ? E().encodeBytes32String(order) : E().id(order));
export const credentialHashOf = (rawId) => E().keccak256(bytes(rawId));
export const paymentIdOf = (siteHash, orderId) => E().keccak256(abi().encode(['bytes32', 'bytes32'], [siteHash, orderId]));
export const paidTopic = () => E().id('Paid(bytes32,bytes32,string,bytes32,address,address,uint256)');

// SiteboundV2: the buyer also signs the site's configVersion, so a payment signed before a payout, split,
// refund-operator, quote-signer or freeze change cannot execute after it.
export const challengeOf = ({ chainId, address, siteHash, configVersion, orderId, amount, relayerFee, deadline }) =>
  E().keccak256(
    abi().encode(
      ['uint256', 'address', 'bytes32', 'uint256', 'bytes32', 'uint256', 'uint256', 'uint256'],
      [chainId, address, siteHash, configVersion, orderId, amount, relayerFee, deadline],
    ),
  );

// A merchant quote, as the <sitebound-pay quote="..."> attribute carries it: "<expiry>.<0x signature>".
// The merchant's backend signs it; the contract checks it, so a bad one only makes the payment fail.
export function quoteOf(text) {
  const m = /^(\d{1,12})\.(0x(?:[0-9a-fA-F]{2}){1,1024})$/.exec(text);
  return m ? { expiry: BigInt(m[1]), sig: m[2] } : null;
}

export const b64url = (b) =>
  btoa(String.fromCharCode(...bytes(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ASN.1 DER `SEQUENCE { INTEGER r, INTEGER s }` -> big-endian ints.
export function derToRS(der) {
  const d = bytes(der);
  const rl = d[3], sl = d[5 + rl];
  if (d[0] !== 0x30 || d[2] !== 0x02 || d[4 + rl] !== 0x02 || d.length !== 6 + rl + sl) throw new Error('Bad DER signature');
  return { r: E().toBigInt(d.slice(4, 4 + rl)), s: E().toBigInt(d.slice(6 + rl, 6 + rl + sl)) };
}

// P-256 SubjectPublicKeyInfo ends with the uncompressed point 04 || x || y.
export function pubKeyXY(spki) {
  const k = bytes(spki);
  if (k.length !== 91 || k[26] !== 0x04) throw new Error('Not a P-256 public key');
  return { x: E().toBigInt(k.slice(27, 59)), y: E().toBigInt(k.slice(59)) };
}

// Offsets of each key's opening quote, as the contract reads them: the byte before must be `{` or `,`.
// Origins are serialized as ASCII, so string offsets equal byte offsets; anything else is refused.
const KEYS = { typeIdx: '"type":', challengeIdx: '"challenge":', originIdx: '"origin":', crossOriginIdx: '"crossOrigin":', topOriginIdx: '"topOrigin":' };
export function offsetsOf(json) {
  if (!/^[\x20-\x7e]*$/.test(json)) throw new Error('clientDataJSON is not plain ASCII');
  const out = {};
  for (const [k, key] of Object.entries(KEYS)) {
    const hits = ['{', ','].map((c) => json.indexOf(c + key)).filter((i) => i >= 0);
    if (!hits.length) throw new Error(`The browser did not sign ${key.slice(0, -1)}`);
    out[k] = Math.min(...hits) + 1;
  }
  return out;
}

// Fails early, before any gas is spent, if the browser signed something the contract will reject.
export function checkClientData(json, { challenge, frameOrigin, topOrigin }) {
  const c = JSON.parse(json);
  if (c.type !== 'webauthn.get') throw new Error('Wrong assertion type');
  if (c.challenge !== b64url(challenge)) throw new Error('The passkey signed a different payment');
  if (c.origin !== frameOrigin || c.crossOrigin !== true) throw new Error('Not signed inside the Sitebound frame');
  if (c.topOrigin !== topOrigin) throw new Error(`The browser reports this page as ${c.topOrigin ?? 'unknown'}, not ${topOrigin}`);
}

export function payInputOf({ rawId, authenticatorData, clientDataJSON, signature, orderId, amount, relayerFee, deadline }) {
  const { r, s } = derToRS(signature);
  return {
    credentialHash: credentialHashOf(rawId),
    authenticatorData: E().hexlify(bytes(authenticatorData)),
    clientDataJSON,
    ...offsetsOf(clientDataJSON),
    r, s, orderId, amount, relayerFee, deadline,
  };
}

export const jsonOf = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

// Wallet and RPC errors can carry endpoint URLs (sometimes with keys): never show those.
export const errText = (e) =>
  String(e?.info?.error?.message || e?.shortMessage || e?.reason || e?.message || e).replace(/\bhttps?:\/\/\S+/g, '[url]').slice(0, 240);
