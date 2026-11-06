import { Contract, JsonRpcProvider, formatEther, Signature, Wallet, getAddress, keccak256, toUtf8Bytes, AbiCoder, ZeroAddress } from "ethers";

export const SITEBOUND_ABI = [
  "function sites(bytes32) view returns (address payout, address pendingPayout, uint64 activeAt, bool frozen, uint256 nonce)",
  "function register(string site, address payout, uint64 deadline, address attestor, uint8 v, bytes32 r, bytes32 s)",
  "function bind(bytes32 credentialHash, uint256 pubX, uint256 pubY, uint256 perPayCap, uint256 totalCap, uint64 expiry, address wallet, uint8 v, bytes32 r, bytes32 s)",
  "function pay((bytes32 credentialHash, bytes authenticatorData, string clientDataJSON, uint256 typeIdx, uint256 challengeIdx, uint256 originIdx, uint256 crossOriginIdx, uint256 topOriginIdx, uint256 r, uint256 s, bytes32 orderId, uint256 amount, uint256 relayerFee, uint256 deadline) p) returns (bytes32)",
  "event PayoutProposed(bytes32 indexed siteHash, address pendingPayout, uint64 activeAt)",
  "event Paid(bytes32 indexed paymentId, bytes32 indexed siteHash, string site, bytes32 orderId, address indexed wallet, address payout, uint256 amount)",
];
const TOKEN_ABI = [
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function allowance(address owner, address spender) view returns (uint256)",
];
const ATTEST_TYPES = {
  Attest: [
    { name: "siteHash", type: "bytes32" },
    { name: "payout", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
};
const PAY_FIELDS = ["credentialHash", "authenticatorData", "clientDataJSON", "typeIdx", "challengeIdx", "originIdx",
  "crossOriginIdx", "topOriginIdx", "r", "s", "orderId", "amount", "relayerFee", "deadline"];
const MAX_BODY = 8192;
const memCaps = new Map();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };

// ------------------------------------------------------------------ site + DNS

/// Returns the exact origin Chrome writes into topOrigin, or throws. Only plain https hostnames.
export function canonicalSite(site) {
  let u;
  try { u = new URL(site); } catch { bad("site must be an https origin like https://shop.com"); }
  if (u.protocol !== "https:") bad("site must use https");
  if (u.port || u.username || u.password) bad("site must not have a port or credentials");
  if (u.origin !== site) bad(`site must be exactly the origin, e.g. ${u.origin}`);
  if (u.hostname.startsWith("[") || /^\d+(\.\d+){3}$/.test(u.hostname) || !u.hostname.includes(".")) bad("site must be a domain name");
  return u.origin;
}

/// The one trusted step: TXT _sitebound.<host> = "sitebound=<payout>", read over DNS-over-HTTPS.
export async function dnsPayout(site) {
  const host = new URL(site).hostname;
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=_sitebound.${host}&type=TXT`, {
    headers: { accept: "application/dns-json" },
  });
  if (!res.ok) bad("DNS lookup failed", 502);
  const body = await res.json();
  if (body.Status !== 0) bad(`no TXT record at _sitebound.${host}`);
  const found = new Set();
  for (const a of body.Answer || []) {
    if (a.type !== 16) continue;
    const txt = a.data.replace(/^"|"$/g, "").replace(/"\s*"/g, "");
    const m = /^sitebound=(0x[0-9a-fA-F]{40})$/.exec(txt.trim());
    if (m) found.add(getAddress(m[1]));
  }
  if (found.size === 0) bad(`no sitebound=<address> TXT record at _sitebound.${host}`);
  if (found.size > 1) bad("more than one sitebound TXT record");
  return [...found][0];
}

// ------------------------------------------------------------------ chain

function chain(env) {
  const chainId = Number(env.CHAIN_ID);
  const provider = new JsonRpcProvider(env.RPC_URL, chainId, { staticNetwork: true, cacheTimeout: -1 });
  const wallet = new Wallet(env.RELAYER_KEY, provider);
  return {
    chainId,
    wallet,
    sb: new Contract(env.SITEBOUND_ADDRESS, SITEBOUND_ABI, wallet),
    token: new Contract(env.TOKEN_ADDRESS, TOKEN_ABI, wallet),
  };
}

let queue = Promise.resolve();
/// One hot EOA: broadcast one tx at a time per isolate so nonces don't collide.
function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

/// Runs the call from the relayer address; a revert comes back to the caller as its reason string.
async function simulate(method, args) {
  try {
    await method.staticCall(...args);
    return await method.estimateGas(...args);
  } catch (e) {
    bad(revertReason(e));
  }
}

async function send(method, args, gas) {
  const tx = await serial(() => method(...args, { gasLimit: (gas * 12n) / 10n }));
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) bad(`transaction reverted: ${tx.hash}`, 502);
  return receipt;
}

function revertReason(e) {
  return e?.reason || e?.revert?.args?.[0] || (e?.code === "CALL_EXCEPTION" ? "reverted" : "simulation failed");
}

function event(sb, receipt, name) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== sb.target.toLowerCase()) continue;
    const parsed = sb.interface.parseLog(log);
    if (parsed?.name === name) return parsed;
  }
}

// ------------------------------------------------------------------ daily caps

async function takeDaily(env, key, limit) {
  const k = `${key}:${Math.floor(Date.now() / 86400000)}`;
  const n = Number(env.CAPS ? await env.CAPS.get(k) : memCaps.get(k)) || 0;
  if (n >= limit) bad("daily limit reached", 429);
  if (env.CAPS) await env.CAPS.put(k, String(n + 1), { expirationTtl: 172800 });
  else memCaps.set(k, n + 1);
}

// ------------------------------------------------------------------ endpoints

// Demo sites on hosts whose DNS we don't control (pages.dev): DEMO_SITES="<origin>=<payout>,..." pins the payout.
// Nothing else bypasses the TXT check, and a pinned site can only register its pinned payout.
async function payoutFor(site, env) {
  for (const pair of (env.DEMO_SITES || "").split(",")) {
    const [origin, payout] = pair.trim().split("=");
    if (origin === site && payout) return getAddress(payout);
  }
  return dnsPayout(site);
}

async function dnsCheck(body, env) {
  const site = canonicalSite(body.site);
  return { ok: true, site, payout: await payoutFor(site, env) };
}

async function register(body, env) {
  const site = canonicalSite(body.site);
  const payout = getAddress(body.payout);
  if ((await payoutFor(site, env)) !== payout) bad("payout does not match the DNS TXT record");

  const { chainId, wallet, sb } = chain(env);
  const siteHash = keccak256(toUtf8Bytes(site));
  const st = await sb.sites(siteHash);
  if (st.payout === payout && st.pendingPayout === ZeroAddress) return { ok: true, already: true };
  if (st.pendingPayout === payout) return { ok: true, pending: true, activeAt: Number(st.activeAt), already: true };
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const domain = { name: "Sitebound", version: "1", chainId, verifyingContract: env.SITEBOUND_ADDRESS };
  const sig = Signature.from(
    await wallet.signTypedData(domain, ATTEST_TYPES, { siteHash, payout, nonce: st.nonce, deadline }),
  );
  const args = [site, payout, deadline, wallet.address, sig.v, sig.r, sig.s];
  const gas = await simulate(sb.register, args);
  await takeDaily(env, `reg:${siteHash}`, Number(env.REGISTER_DAILY_CAP || 3));
  const receipt = await send(sb.register, args, gas);
  const proposed = event(sb, receipt, "PayoutProposed");
  if (proposed) return { ok: true, txHash: receipt.hash, pending: true, activeAt: Number(proposed.args.activeAt) };
  return { ok: true, txHash: receipt.hash, siteHash };
}

async function setup(body, env) {
  const b = body.bind || bad("bind missing");
  const owner = getAddress(body.owner ?? b.wallet ?? bad("owner missing"));
  const { sb, token } = chain(env);
  const bindArgs = [b.credentialHash, b.pubX, b.pubY, b.perPayCap, b.totalCap, b.expiry, owner, b.v, b.r, b.s];
  const bindGas = await simulate(sb.bind, bindArgs);

  const p = body.permit;
  const permitArgs = p && [owner, env.SITEBOUND_ADDRESS, p.value, p.deadline, p.v, p.r, p.s];
  const permitGas = p && (await simulate(token.permit, permitArgs).catch(() => null));
  const allowanceOk = async () => (await token.allowance(owner, env.SITEBOUND_ADDRESS)) >= BigInt(b.totalCap);
  if (!permitGas && !(await allowanceOk())) bad("permit failed and allowance is below totalCap");
  await takeDaily(env, `setup:${owner}`, Number(env.SETUP_DAILY_CAP || 3));
  let permitTx;
  if (permitGas) {
    permitTx = await send(token.permit, permitArgs, permitGas).then((r) => r.hash, () => undefined);
    if (!permitTx && !(await allowanceOk())) bad("permit failed and allowance is below totalCap");
  }

  const receipt = await send(sb.bind, bindArgs, bindGas);
  return { ok: true, txHash: receipt.hash, permitTxHash: permitTx };
}

async function pay(body, env) {
  const input = {};
  for (const f of PAY_FIELDS) input[f] = body[f] ?? bad(`${f} missing`);
  const minFee = BigInt(env.MIN_FEE ?? 10000);
  if (BigInt(input.relayerFee) < minFee) bad(`relayerFee must be at least ${minFee}`);

  const { sb } = chain(env);
  const gas = await simulate(sb.pay, [input]);
  await takeDaily(env, `pay:${input.credentialHash}`, Number(env.PAY_DAILY_CAP || 20));
  const receipt = await send(sb.pay, [input], gas);
  const paid = event(sb, receipt, "Paid");
  const paymentId = paid
    ? paid.args.paymentId
    : keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [topOriginHash(input.clientDataJSON, input.topOriginIdx), input.orderId]));
  return { ok: true, txHash: receipt.hash, paymentId };
}

function topOriginHash(json, idx) {
  const from = Number(idx) + 13;
  return keccak256(toUtf8Bytes(json.slice(from, json.indexOf('"', from))));
}

// ------------------------------------------------------------------ http

const ROUTES = { "/dns/check": dnsCheck, "/register": register, "/setup": setup, "/pay": pay };

function cors(req, env) {
  const origin = req.headers.get("origin");
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = { vary: "origin" };
  if (origin && (allowed.includes("*") || allowed.includes(origin))) {
    h["access-control-allow-origin"] = origin;
    h["access-control-allow-methods"] = "GET, POST, OPTIONS";
    h["access-control-allow-headers"] = "content-type";
    h["access-control-max-age"] = "86400";
  }
  return { h, ok: !origin || "access-control-allow-origin" in h };
}

function redact(msg, env, urls = true) {
  let s = String(msg);
  if (env.RPC_URL) s = s.split(env.RPC_URL).join("[rpc]");
  return (urls ? s.replace(/https?:\/\/[^\s"'<>]+/g, "[url]") : s).slice(0, 300);
}

export async function handle(req, env) {
  const { h, ok } = cors(req, env);
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...h, "content-type": "application/json" } });
  const path = new URL(req.url).pathname;
  if (req.method === "OPTIONS") return new Response(null, { status: ok ? 204 : 403, headers: h });
  if (!ok) return json({ error: "origin not allowed" }, 403);

  try {
    if (req.method === "GET" && path === "/health") {
      const out = { ok: true, relayer: new Wallet(env.RELAYER_KEY).address, chainId: Number(env.CHAIN_ID),
        limits: { minFeeBaseUnits: String(env.MIN_FEE ?? 10000), payPerPasskeyPerDay: Number(env.PAY_DAILY_CAP || 20),
          registerPerSitePerDay: Number(env.REGISTER_DAILY_CAP || 3), setupPerWalletPerDay: Number(env.SETUP_DAILY_CAP || 3) } };
      try { out.gasBalanceWbt = formatEther(await chain(env).wallet.provider.getBalance(out.relayer)); } catch { out.gasBalanceWbt = null; }
      return json(out);
    }
    const route = ROUTES[path];
    if (!route) return json({ error: "not found" }, 404);
    if (req.method !== "POST") return json({ error: "use POST" }, 405);
    const text = await req.text();
    if (text.length > MAX_BODY) bad("body too large", 413);
    let body;
    try { body = JSON.parse(text); } catch { bad("invalid JSON"); }
    return json(await route(body || {}, env));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: redact(e.message, env, false) }, e.status);
    if (e?.code === "INVALID_ARGUMENT" || e instanceof SyntaxError) return json({ error: redact(e.shortMessage || e.message, env) }, 400);
    console.log("relayer error", redact(e?.shortMessage || e?.message, env));
    return json({ error: "relayer error" }, 502);
  }
}

export default { fetch: handle };
