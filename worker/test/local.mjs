// Local end-to-end test: anvil (chain 1874, osaka = P-256 at 0x100) + the worker handlers called directly,
// then the same worker under `wrangler dev` (workerd + bundled ethers). Run from worker/: `node test/local.mjs`.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AbiCoder, Contract, Interface, JsonRpcProvider, Signature, Wallet, keccak256, sha256, toUtf8Bytes, zeroPadValue, MaxUint256 } from "ethers";
import { handle, SITEBOUND_ABI } from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.ANVIL_PORT || 8545);
const RPC = `http://127.0.0.1:${PORT}`;
const FIX = JSON.parse(readFileSync(join(ROOT, "test/fixtures/frame_assertion_v2.json"), "utf8"));
const SB = FIX.contract; // the fixture's challenge commits to this address and chain 1874
// anvil's public default dev keys (test only)
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9b804cdd2b0db",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
];
const provider = new JsonRpcProvider(RPC, 1874, { staticNetwork: true, cacheTimeout: -1 });
const [relayer, buyer, shop, deployer, newShop, stranger, fixtureShop] = KEYS.map((k) => new Wallet(k, provider));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++, console.log(`  ok   ${name}`);
  else fail++, console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
}

function kv() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v) };
}

// DoH stub: only cloudflare-dns.com is intercepted; ethers in Node does not use fetch.
const TXT = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(typeof url === "string" ? url : url.url);
  if (u.hostname !== "cloudflare-dns.com") return realFetch(url, init);
  const name = u.searchParams.get("name").replace(/^_sitebound\./, "");
  const data = TXT[name];
  const body = data ? { Status: 0, Answer: data.map((d) => ({ name: u.searchParams.get("name"), type: 16, data: d })) } : { Status: 3 };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/dns-json" } });
};

async function call(env, path, body, { method = "POST", origin = "http://localhost:8002" } = {}) {
  const headers = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  const res = await handle(new Request(`http://relayer${path}`, { method, headers, body: method === "POST" ? JSON.stringify(body) : undefined }), env);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : null };
}

async function waitRpc(url) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await realFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("rpc did not start");
}

function forgeCreate(contract, args = []) {
  const out = execFileSync("forge", ["create", contract, "--rpc-url", RPC, "--private-key", deployer.privateKey, "--broadcast", "--json",
    ...(args.length ? ["--constructor-args", ...args] : [])], { cwd: ROOT, encoding: "utf8" });
  return JSON.parse(out.slice(out.indexOf("{"))).deployedTo;
}

const sbAbi = new Interface([
  "function sites(bytes32) view returns (address payout, address pendingPayout, uint64 activeAt, bool frozen, uint256 nonce)",
  "function buyers(bytes32) view returns (address wallet, uint256 pubX, uint256 pubY, uint256 perPayCap, uint256 totalCap, uint256 spent, uint64 expiry)",
  "function bindNonce(address) view returns (uint256)",
  "function token() view returns (address)",
  "function rpIdHash() view returns (bytes32)",
  "function delay() view returns (uint64)",
  "function isAttestor(address) view returns (bool)",
  "function quorum() view returns (uint256 setId, uint256 threshold)",
  "function configVersion(bytes32) view returns (uint256)",
  "function register(string site, address[] to, uint16[] bps, (uint64 deadline, uint8 v, bytes32 r, bytes32 s)[] sigs)",
]);
const tokenAbi = ["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];

async function main() {
  const anvil = spawn("anvil", ["--chain-id", "1874", "--port", String(PORT), "--hardfork", "osaka", "--silent"], { stdio: "ignore" });
  const stop = [() => anvil.kill()];
  process.on("exit", () => stop.forEach((f) => f()));
  try {
    await waitRpc(RPC);
    await run(stop);
  } finally {
    stop.forEach((f) => f());
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

async function run(stop) {
  console.log("deploy");
  const tokenAddr = forgeCreate("test/utils/MockToken.sol:MockToken");
  const proto = forgeCreate("src/SiteboundV2.sol:SiteboundV2", [tokenAddr, FIX.frameOrigin, sha256(toUtf8Bytes(FIX.rpId)), `[${relayer.address}]`, "1", "60", "0x0000000000000000000000000000000000000000"]);
  // Place the contract at the fixture address: immutables ride in the code; copy the constructor-written slots
  // (forge inspect SiteboundV2 storageLayout): 0 frameOrigin, 2 inSet[1][relayer], 3 setCount, 4 activeSet,
  // 5 activeThreshold, 10 _lock.
  const abiC = AbiCoder.defaultAbiCoder();
  const attSlot = keccak256(abiC.encode(["address", "bytes32"], [relayer.address, keccak256(abiC.encode(["uint256", "uint256"], [1, 2]))]));
  await provider.send("anvil_setCode", [SB, await provider.getCode(proto)]);
  for (const slot of [0, 3, 4, 5, 10].map((n) => zeroPadValue(`0x${n.toString(16).padStart(2, "0")}`, 32)).concat(attSlot)) {
    await provider.send("anvil_setStorageAt", [SB, slot, await provider.getStorage(proto, slot)]);
  }
  const sb = new Contract(SB, sbAbi, deployer);
  check("contract at fixture address: token", (await sb.token()) === tokenAddr);
  check("contract at fixture address: rpIdHash", (await sb.rpIdHash()) === sha256(toUtf8Bytes("localhost")));
  check("contract at fixture address: delay 60", (await sb.delay()) === 60n);
  check("contract at fixture address: relayer is attestor", await sb.isAttestor(relayer.address));
  const [setId0, k0] = await sb.quorum();
  check("contract at fixture address: quorum is set 1, 1-of-1", setId0 === 1n && k0 === 1n);

  const real = new Interface(JSON.parse(readFileSync(join(ROOT, "out/SiteboundV2.sol/SiteboundV2.json"), "utf8")).abi);
  const mine = new Interface(SITEBOUND_ABI);
  for (const fn of ["sites", "register", "quorum", "bind", "pay", "payWithQuote"]) {
    check(`worker ABI ${fn} selector matches forge ABI`, mine.getFunction(fn).selector === real.getFunction(fn).selector);
  }
  for (const ev of ["PayoutProposed", "Paid"]) check(`worker ABI ${ev} topic matches`, mine.getEvent(ev).topicHash === real.getEvent(ev).topicHash);

  const token = new Contract(tokenAddr, tokenAbi, deployer);
  await (await token.mint(buyer.address, 1000_000000n)).wait();
  await (await token.connect(buyer).approve(SB, MaxUint256)).wait();

  const base = {
    RPC_URL: RPC, RELAYER_KEY: relayer.privateKey, CHAIN_ID: "1874", SITEBOUND_ADDRESS: SB, TOKEN_ADDRESS: tokenAddr,
    ALLOWED_ORIGINS: "http://localhost:8002, http://127.0.0.1:8003",
  };
  const env = (extra = {}) => ({ ...base, CAPS: kv(), ...extra });

  console.log("health + cors");
  let r = await call(env(), "/health", null, { method: "GET" });
  check("health", r.status === 200 && r.json.relayer === relayer.address && r.json.chainId === 1874, r.json);
  check("health leaks no key/rpc", !r.text.includes(relayer.privateKey.slice(2)) && !r.text.includes("127.0.0.1"));
  r = await call(env(), "/pay", {}, { method: "OPTIONS" });
  check("preflight allowed origin", r.status === 204 && r.headers.get("access-control-allow-origin") === "http://localhost:8002");
  r = await call(env(), "/dns/check", { site: "https://shop.example" }, { origin: "https://evil.example" });
  check("other origin rejected", r.status === 403 && !r.headers.get("access-control-allow-origin"), r.json);
  r = await call(env(), "/nope", {});
  check("unknown path 404", r.status === 404);

  console.log("/dns/check");
  TXT["shop.example"] = [`"sitebound=${shop.address}"`, '"v=spf1 -all"'];
  TXT["split.example"] = [`"sitebound=${shop.address.slice(0, 20)}" "${shop.address.slice(20)}"`];
  r = await call(env(), "/dns/check", { site: "https://shop.example" });
  check("dns ok", r.status === 200 && r.json.payout === shop.address, r.json);
  r = await call(env(), "/dns/check", { site: "https://split.example" });
  check("dns split TXT chunks joined", r.json.payout === shop.address, r.json);
  for (const site of ["http://shop.example", "https://shop.example:8443", "https://1.2.3.4", "https://[::1]", "https://shop.example/x",
    "https://shop.example/", "https://Shop.example", "https://user@shop.example", "https://localhost", "shop.example", 42]) {
    r = await call(env(), "/dns/check", { site });
    check(`dns rejects ${JSON.stringify(site)}`, r.status === 400, r.json);
  }
  r = await call(env(), "/dns/check", { site: "https://none.example" });
  check("dns missing record", r.status === 400 && /TXT/.test(r.json.error), r.json);
  TXT["two.example"] = [`"sitebound=${shop.address}"`, `"sitebound=${newShop.address}"`];
  r = await call(env(), "/dns/check", { site: "https://two.example" });
  check("dns two different records rejected", r.status === 400, r.json);

  console.log("/register");
  const shopHash = keccak256(toUtf8Bytes("https://shop.example"));
  r = await call(env(), "/register", { site: "https://shop.example", payout: newShop.address });
  check("register payout != TXT rejected", r.status === 400 && /does not match/.test(r.json.error), r.json);
  let nonceBefore = await provider.getTransactionCount(relayer.address);
  r = await call(env(), "/register", { site: "https://shop.example", payout: shop.address });
  check("register new site", r.status === 200 && /^0x[0-9a-f]{64}$/.test(r.json.txHash) && !r.json.pending, r.json);
  check("register on-chain payout", (await sb.sites(shopHash)).payout === shop.address);
  check("register used one relayer tx", (await provider.getTransactionCount(relayer.address)) === nonceBefore + 1);
  r = await call(env(), "/register", { site: "https://shop.example", payout: shop.address });
  check("register same payout is a no-op", r.status === 200 && r.json.already && !r.json.txHash, r.json);
  TXT["shop.example"] = [`"sitebound=${newShop.address}"`];
  r = await call(env(), "/register", { site: "https://shop.example", payout: newShop.address });
  const st = await sb.sites(shopHash);
  check("register existing site -> pending", r.status === 200 && r.json.pending === true && r.json.activeAt === Number(st.activeAt) && st.pendingPayout === newShop.address && st.payout === shop.address, r.json);
  const capped = env({ REGISTER_DAILY_CAP: "0" });
  TXT["capped.example"] = [`"sitebound=${shop.address}"`];
  r = await call(capped, "/register", { site: "https://capped.example", payout: shop.address });
  check("register per-site daily cap", r.status === 429, r.json);

  console.log("DEMO_SITES");
  const DEMO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const demoEnv = env({ DEMO_SITES: `https://demo.example=${DEMO}` });
  let dohCalls = 0;
  const stubFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (new URL(typeof url === "string" ? url : url.url).hostname === "cloudflare-dns.com") dohCalls++;
    return stubFetch(url, init);
  };
  r = await call(demoEnv, "/dns/check", { site: "https://demo.example" });
  check("demo site: dns/check ok with the pinned payout", r.status === 200 && r.json.ok === true && r.json.payout === DEMO, r.json);
  check("demo site: no DNS lookup", dohCalls === 0, dohCalls);
  r = await call(demoEnv, "/register", { site: "https://demo.example", payout: shop.address });
  check("demo site: register with a different payout rejected", r.status === 400 && /does not match/.test(r.json.error), r.json);
  check("demo site: register rejection did no DNS lookup", dohCalls === 0, dohCalls);
  r = await call(demoEnv, "/dns/check", { site: "https://notdemo.example" });
  check("site not in DEMO_SITES goes through DNS and is rejected without TXT", r.status === 400 && /TXT/.test(r.json.error) && dohCalls === 1, { json: r.json, dohCalls });
  r = await call(demoEnv, "/dns/check", { site: "https://shop.example" });
  check("site not in DEMO_SITES uses its TXT payout", r.status === 200 && r.json.payout === newShop.address && dohCalls === 2, { json: r.json, dohCalls });
  const malformed = env({ DEMO_SITES: `https://bad.example, https://demo.example=${DEMO}` });
  TXT["bad.example"] = [`"sitebound=${shop.address}"`];
  dohCalls = 0;
  r = await call(malformed, "/dns/check", { site: "https://bad.example" });
  check("malformed DEMO_SITES entry (no '=') ignored, DNS used", r.status === 200 && r.json.payout === shop.address && dohCalls === 1, { json: r.json, dohCalls });
  r = await call(malformed, "/dns/check", { site: "https://demo.example" });
  check("valid entry after a malformed one still works", r.status === 200 && r.json.payout === DEMO && dohCalls === 1, { json: r.json, dohCalls });
  globalThis.fetch = stubFetch;

  // The fixture shop is http://127.0.0.1:8001, which the relayer refuses to attest; the test signs it as the attestor directly.
  const fxHash = keccak256(toUtf8Bytes(FIX.topOrigin));
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const domain = { name: "Sitebound", version: "1", chainId: 1874, verifyingContract: SB };
  const att = Signature.from(await relayer.signTypedData(domain,
    { Attest: [{ name: "siteHash", type: "bytes32" }, { name: "to", type: "address[]" }, { name: "bps", type: "uint16[]" }, { name: "nonce", type: "uint256" }, { name: "setId", type: "uint256" }, { name: "deadline", type: "uint64" }] },
    { siteHash: fxHash, to: [fixtureShop.address], bps: [10000], nonce: 0, setId: 1, deadline }));
  await (await sb.register(FIX.topOrigin, [fixtureShop.address], [10000], [[deadline, att.v, att.r, att.s]])).wait();
  check("fixture site registered once: configVersion is the fixture's", (await sb.configVersion(fxHash)) === BigInt(FIX.configVersion));
  r = await call(env(), "/register", { site: FIX.topOrigin, payout: fixtureShop.address });
  check("register refuses the http fixture site", r.status === 400, r.json);

  console.log("/setup");
  const BIND = { Bind: ["bytes32 credentialHash", "uint256 pubX", "uint256 pubY", "uint256 perPayCap", "uint256 totalCap", "uint64 expiry", "uint256 nonce"]
    .map((s) => ({ type: s.split(" ")[0], name: s.split(" ")[1] })) };
  const cred = keccak256(FIX.credId);
  const expiry = Math.floor(Date.now() / 1000) + 30 * 86400;
  async function bindReq(w, c = cred, pubX = FIX.pubX, pubY = FIX.pubY, signer = w) {
    const v = { credentialHash: c, pubX, pubY, perPayCap: "50000000", totalCap: "100000000", expiry, nonce: await sb.bindNonce(w.address) };
    const sig = Signature.from(await signer.signTypedData(domain, BIND, v));
    return { owner: w.address, bind: { ...v, nonce: undefined, v: sig.v, r: sig.r, s: sig.s } };
  }
  const fakePermit = { value: "100000000", deadline: String(deadline), v: 27, r: zeroPadValue("0x01", 32), s: zeroPadValue("0x02", 32) };
  r = await call(env(), "/setup", { ...(await bindReq(buyer, cred, FIX.pubX, FIX.pubY, stranger)), permit: fakePermit });
  check("setup with wrong signer rejected by simulation", r.status === 400 && r.json.error === "bad binding signature", r.json);
  const setupEnv = env({ SETUP_DAILY_CAP: "1" });
  nonceBefore = await provider.getTransactionCount(relayer.address);
  r = await call(setupEnv, "/setup", { ...(await bindReq(buyer)), permit: fakePermit });
  check("setup: permit fails on MockToken, allowance already set -> bind only", r.status === 200 && r.json.txHash && !r.json.permitTxHash, r.json);
  check("setup: one relayer tx (no permit sent)", (await provider.getTransactionCount(relayer.address)) === nonceBefore + 1);
  check("setup: bound on-chain", (await sb.buyers(cred)).wallet === buyer.address);
  r = await call(setupEnv, "/setup", await bindReq(buyer));
  check("setup per-owner daily cap", r.status === 429, r.json);
  r = await call(env(), "/setup", { ...(await bindReq(stranger, keccak256("0x1234"), "1", "2")), permit: fakePermit });
  check("setup: no permit and no allowance rejected", r.status === 400 && /allowance/.test(r.json.error), r.json);

  console.log("/pay");
  const input = {
    credentialHash: cred, authenticatorData: FIX.authenticatorData, clientDataJSON: FIX.clientDataJSON,
    typeIdx: FIX.clientDataJSON.indexOf('"type":'), challengeIdx: FIX.clientDataJSON.indexOf('"challenge":'),
    originIdx: FIX.clientDataJSON.indexOf('"origin":'), crossOriginIdx: FIX.clientDataJSON.indexOf('"crossOrigin":'),
    topOriginIdx: FIX.clientDataJSON.indexOf('"topOrigin":'), r: FIX.r, s: FIX.s, orderId: FIX.orderId,
    amount: String(FIX.amount), relayerFee: String(FIX.relayerFee), deadline: String(FIX.deadline),
  };
  r = await call(env(), "/pay", input);
  check("pay: fee below default MIN_FEE rejected", r.status === 400 && /relayerFee/.test(r.json.error), r.json);
  r = await call(env({ MIN_FEE: "0" }), "/pay", { ...input, amount: undefined });
  check("pay: missing field rejected", r.status === 400, r.json);
  nonceBefore = await provider.getTransactionCount(relayer.address);
  const tampered = { ...input, orderId: zeroPadValue("0x01", 32).replace(/^0x00/, "0x66") };
  r = await call(env({ MIN_FEE: "0" }), "/pay", tampered);
  check("pay: simulation revert reason returned", r.status === 400 && r.json.error === "bad challenge", r.json);
  r = await call(env({ MIN_FEE: "0" }), "/pay", { ...input, amount: String(FIX.amount + 1) });
  check("pay: tampered amount -> bad challenge", r.json?.error === "bad challenge", r.json);
  r = await call(env({ MIN_FEE: "0" }), "/pay", { ...input, quoteExpiry: "1900000000", quoteSig: "nothex" });
  check("pay: malformed quote rejected before simulation", r.status === 400 && r.json.error === "bad quote format", r.json);
  r = await call(env({ MIN_FEE: "0" }), "/pay", { ...input, quoteExpiry: "1900000000", quoteSig: "0x" + "11".repeat(65) });
  check("pay: quote for a site without a quote signer -> payWithQuote reverts", r.status === 400 && r.json.error === "no quote signer", r.json);
  const full = env({ MIN_FEE: "0", PAY_DAILY_CAP: "1" });
  const today = Math.floor(Date.now() / 86400000);
  full.CAPS.m.set(`pay:${cred}:${today}`, "1");
  r = await call(full, "/pay", input);
  check("pay: per-buyer daily cap (after a passing simulation)", r.status === 429, r.json);
  check("pay: rejected calls sent no tx", (await provider.getTransactionCount(relayer.address)) === nonceBefore);

  const payEnv = env({ MIN_FEE: "0" });
  r = await call(payEnv, "/pay", input);
  const expectId = keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [fxHash, FIX.orderId]));
  check("pay: real Chrome assertion paid", r.status === 200 && r.json.paymentId === expectId && /^0x[0-9a-f]{64}$/.test(r.json.txHash), r.json);
  const receipt = await provider.getTransactionReceipt(r.json?.txHash);
  check("pay: tx mined from relayer, status 1", receipt?.status === 1 && receipt.from === relayer.address && receipt.to.toLowerCase() === SB.toLowerCase(), receipt && { status: receipt.status, from: receipt.from, to: receipt.to });
  check("pay: shop got 12 USDT", (await token.balanceOf(fixtureShop.address)) === 12_000000n);
  check("pay: buyer cap counted in KV", payEnv.CAPS.m.get(`pay:${cred}:${today}`) === "1");
  r = await call(env({ MIN_FEE: "0" }), "/pay", input);
  check("pay: replay -> order used", r.status === 400 && r.json.error === "order used", r.json);

  console.log("redaction");
  const secretRpc = "http://127.0.0.1:1/v2/SECRETKEY123";
  r = await call(env({ RPC_URL: secretRpc, MIN_FEE: "0" }), "/pay", input);
  check("pay with dead RPC: no URL in error", r.status >= 400 && !r.text.includes("SECRETKEY123"), r.text);
  TXT["dead.example"] = [`"sitebound=${shop.address}"`];
  r = await call(env({ RPC_URL: secretRpc }), "/register", { site: "https://dead.example", payout: shop.address });
  check("register with dead RPC: no URL in error", r.status === 502 && !r.text.includes("SECRETKEY123"), r.text);

  if (process.env.SKIP_WRANGLER) return;
  console.log("wrangler dev (workerd + bundled ethers)");
  const vars = { RPC_URL: RPC, RELAYER_KEY: relayer.privateKey, SITEBOUND_ADDRESS: SB, TOKEN_ADDRESS: tokenAddr, MIN_FEE: "0" };
  const wr = spawn("npx", ["wrangler", "dev", "--port", "8799", "--ip", "127.0.0.1", ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])],
    { cwd: join(ROOT, "worker"), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, detached: true });
  stop.push(() => { try { process.kill(-wr.pid); } catch {} });
  let log = "";
  wr.stdout.on("data", (d) => (log += d));
  wr.stderr.on("data", (d) => (log += d));
  let health;
  for (let i = 0; i < 60 && !health; i++) {
    await new Promise((res) => setTimeout(res, 500));
    try { health = await (await realFetch("http://127.0.0.1:8799/health")).json(); } catch {}
  }
  check("workerd: /health", health?.relayer === relayer.address && health?.chainId === 1874, health ?? log.slice(-500).replaceAll(relayer.privateKey, "[key]"));
  const post = async (path, body) => (await realFetch(`http://127.0.0.1:8799${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  check("workerd: /pay simulation reason", (await post("/pay", tampered)).error === "bad challenge");
  check("workerd: /pay replay reason", (await post("/pay", input)).error === "order used");
}

main().catch((e) => {
  console.error("test crashed:", String(e?.shortMessage || e?.message || e).slice(0, 300));
  process.exit(1);
});
