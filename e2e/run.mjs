// End-to-end run, no human. anvil (chain 1874) with the test P-256 verifier etched at 0x100, PermitToken and
// SiteboundV2 deployed with `forge create`, the worker's handle() behind a local HTTP server, web/ served by
// web/dev/serve.py, and headless Chromium with a CDP virtual authenticator and a window.ethereum that forwards
// to anvil's unlocked dev accounts (no key in the page).
// Flow: shop registers -> buyer sets up (passkey, permit, bind) -> pays via the relayer -> pays from the wallet
// (popup path, then a wallet inside the iframe) -> shop refunds in the dashboard -> shop turns on merchant quotes:
// a quoted payment goes through and a page-changed amount does not. Each step checks the chain.
// Run: cd e2e && npm install && npm test. Env: CHROME=<binary>, E2E_HEADED=1 to watch, E2E_BLOCK_TIME=<s>.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbiCoder, Contract, HDNodeWallet, JsonRpcProvider, Signature, ZeroAddress, concat, encodeBytes32String, getBytes, id, keccak256, sha256, toUtf8Bytes } from 'ethers';
import { chromium } from 'playwright-core';
import * as ethersNs from 'ethers';

globalThis.ethers ??= ethersNs; // the merchant helper uses a global ethers when one is loaded
const M = await import('../web/merchant/sitebound-merchant.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, '.out');
const BUILD = mkdtempSync(join(os.tmpdir(), 'sitebound-e2e-')); // forge output, so the shared out/ is left alone
const CHROME = process.env.CHROME || join(os.homedir(),
  'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

// The local dev origins from INTERFACE.md. They are routed inside the browser to serve.py on free ports,
// so whatever already listens on 8001/8002 is left alone.
const SHOP = 'http://127.0.0.1:8001';
const FRAME = 'http://localhost:8002';
const MNEMONIC = 'test test test test test test test test test test test junk'; // anvil's public dev accounts
const dev = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`);
const [deployer, relayer, buyer, shop, merchantKey] = [0, 1, 2, 3, 4].map(dev);
const USDT = (n) => BigInt(Math.round(n * 1e6));
const abi = AbiCoder.defaultAbiCoder();

const SB_ABI = [
  'function register(string site, address[] to, uint16[] bps, (uint64 deadline, uint8 v, bytes32 r, bytes32 s)[] sigs)',
  'function quorum() view returns (uint256 setId, uint256 threshold)',
  'function setQuoteSigner(bytes32 siteHash, address signer)',
  'function configVersion(bytes32) view returns (uint256)',
  'function sites(bytes32) view returns (address payout, address pendingPayout, uint64 activeAt, bool frozen, uint256 nonce)',
  'function buyers(bytes32) view returns (address wallet, uint256 pubX, uint256 pubY, uint256 perPayCap, uint256 totalCap, uint256 spent, uint64 expiry)',
  'function payments(bytes32) view returns (address wallet, bytes32 siteHash, uint256 amount, uint256 refunded)',
];
const TOKEN_ABI = ['function mint(address,uint256)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'];

const procs = [];
const pages = [];
let browser;

// ------------------------------------------------------------------ helpers

class Stop extends Error {}
const say = (e) => String(e?.shortMessage || e?.message || e).split('\n')[0].slice(0, 400);

async function step(name, fn) {
  const t = Date.now();
  try {
    const note = await fn();
    console.log(`ok    ${name}${note ? `: ${note}` : ''} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  } catch (e) {
    console.log(`FAIL  ${name}: ${say(e)}`);
    mkdirSync(OUT, { recursive: true });
    for (const [i, p] of pages.entries()) {
      if (p.page.isClosed()) continue;
      await p.page.screenshot({ path: join(OUT, `${name.replace(/\W+/g, '-')}-${i}-${p.name}.png`) }).catch(() => {});
      for (const line of p.log.slice(-8)) console.log(`      [${p.name}] ${line}`);
    }
    throw new Stop();
  }
}

function expect(cond, what) {
  if (!cond) throw new Error(what);
}

const portFree = (port) => new Promise((res) => {
  const s = net.createServer().once('error', () => res(false));
  s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
});
const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function waitHttp(url, init) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url, init)).status < 500) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} did not come up`);
}

function start(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { cwd: ROOT, stdio: 'ignore', ...opts });
  procs.push(p);
  return p;
}

function forgeCreate(target, args = []) {
  const out = execFileSync('forge', ['create', target, '--rpc-url', RPC, '--unlocked', '--from', deployer.address, '--broadcast', '--json',
    '--out', join(BUILD, 'out'), '--cache-path', join(BUILD, 'cache'), ...(args.length ? ['--constructor-args', ...args] : [])],
  { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.slice(out.indexOf('{'))).deployedTo;
}

// Polls until `ok` is visible, or throws the text of `err` if that shows first.
async function until(root, ok, err, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await root.locator(ok).first().isVisible().catch(() => false)) return;
    const e = root.locator(err).first();
    if (await e.isVisible().catch(() => false)) {
      const text = (await e.textContent()).trim();
      if (text) throw new Error(`page says: ${text}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${ok}`);
}

// An EIP-1193 provider for one anvil dev account; anvil holds the key. Top-level pages only, unless `inFrames`:
// whether a real wallet answers inside a cross-origin iframe is not checked, so by default the frame takes its
// popup path (send.html), as it would with no wallet in the iframe.
function walletStub({ rpc, account, chainId, inFrames }) {
  if (window.top !== window && !inFrames) return;
  let n = 0;
  const own = (a) => String(a).toLowerCase() === account.toLowerCase();
  window.ethereum = {
    async request({ method, params = [] }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
      if (method === 'eth_sendTransaction' && !own(params[0]?.from)) throw Object.assign(new Error('unknown account'), { code: 4100 });
      if (method === 'eth_signTypedData_v4' && !own(params[0])) throw Object.assign(new Error('unknown account'), { code: 4100 });
      const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
      const j = await res.json();
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
      return j.result;
    },
    on() {},
    removeListener() {},
  };
}

async function authenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const list = async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
  return { list, add: (credential) => cdp.send('WebAuthn.addCredential', { authenticatorId, credential }) };
}

function track(name, page) {
  const p = { name, page, log: [] };
  page.on('console', (m) => m.type() === 'error' && p.log.push(m.text().slice(0, 300)));
  page.on('pageerror', (e) => p.log.push(`pageerror ${say(e)}`));
  pages.push(p);
  return page;
}

// ------------------------------------------------------------------ setup

const ANVIL_PORT = (await portFree(8545)) ? 8545 : await freePort();
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const provider = new JsonRpcProvider(RPC, 1874, { staticNetwork: true, pollingInterval: 250 });
const FIX = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/frame_assertion.json'), 'utf8'));
let sb, token, relayerUrl, config;
const siteHash = keccak256(toUtf8Bytes(SHOP));
const paymentId = (order) => keccak256(abi.encode(['bytes32', 'bytes32'], [siteHash, encodeBytes32String(order)]));
const bal = async (a) => token.balanceOf(a);

async function main() {
  await step('anvil: chain 1874, P-256 verifier etched at 0x100', async () => {
    // prague has no native 0x100, so the etched contract is what runs (osaka would shadow it).
    // Instant automine by default: a receipt within 250 ms is what exposed the relayer's cached-nonce bug (b379c0c).
    // E2E_BLOCK_TIME=1 mines like a real chain instead.
    const blockTime = process.env.E2E_BLOCK_TIME ? ['--block-time', process.env.E2E_BLOCK_TIME] : [];
    start('anvil', ['--chain-id', '1874', '--port', String(ANVIL_PORT), '--hardfork', 'prague', ...blockTime, '--silent']);
    await waitHttp(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
    const accounts = await provider.send('eth_accounts', []);
    expect([deployer, relayer, buyer, shop].every((w, i) => w.address.toLowerCase() === accounts[i].toLowerCase()), 'anvil accounts differ from the dev mnemonic');
    const verifier = forgeCreate('test/utils/P256Verifier.sol:P256Verifier');
    await provider.send('anvil_setCode', ['0x0000000000000000000000000000000000000100', await provider.getCode(verifier)]);
    const hash = sha256(concat([FIX.authenticatorData, getBytes(sha256(toUtf8Bytes(FIX.clientDataJSON)))]));
    const out = await provider.call({ to: '0x0000000000000000000000000000000000000100', data: abi.encode(['bytes32', 'uint256', 'uint256', 'uint256', 'uint256'], [hash, FIX.r, FIX.s, FIX.pubX, FIX.pubY]) });
    expect(out !== '0x' && BigInt(out) === 1n, `0x100 rejected the real Chrome fixture signature (${out})`);
    return `port ${ANVIL_PORT}, fixture signature verifies`;
  });

  await step('deploy PermitToken and SiteboundV2 with forge create', async () => {
    const tokenAddr = forgeCreate('e2e/PermitToken.sol:PermitToken');
    // 1-of-1 attestor (the relayer), 60 s delay, no guardian
    const sbAddr = forgeCreate('src/SiteboundV2.sol:SiteboundV2', [tokenAddr, FRAME, sha256(toUtf8Bytes('localhost')), `[${relayer.address}]`, '1', '60', ZeroAddress]);
    const signer = await provider.getSigner(deployer.address);
    sb = new Contract(sbAddr, SB_ABI, signer);
    token = new Contract(tokenAddr, TOKEN_ABI, signer);
    await (await token.mint(buyer.address, USDT(100))).wait();
    return `SiteboundV2 ${sbAddr}, buyer minted 100 USDT`;
  });

  await step('relayer: worker handle() on a local port', async () => {
    let handle;
    try {
      ({ handle } = await import('../worker/src/index.js'));
    } catch (e) {
      throw new Error(`cannot load worker/src/index.js (npm install in worker/?): ${say(e)}`);
    }
    const env = {
      RPC_URL: RPC, RELAYER_KEY: relayer.privateKey, CHAIN_ID: '1874', SITEBOUND_ADDRESS: sb.target, TOKEN_ADDRESS: token.target, ALLOWED_ORIGINS: FRAME,
    };
    const port = await freePort();
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = {};
      for (const h of ['content-type', 'origin']) if (req.headers[h]) headers[h] = req.headers[h];
      const r = await handle(new Request(`http://127.0.0.1:${port}${req.url}`, {
        method: req.method, headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks),
      }), env);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    procs.push({ kill: () => server.close() });
    relayerUrl = `http://127.0.0.1:${port}`;
    const health = await (await fetch(`${relayerUrl}/health`)).json();
    expect(health.relayer === relayer.address && health.chainId === 1874, `health: ${JSON.stringify(health)}`);
    const reg = await fetch(`${relayerUrl}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ site: SHOP, payout: shop.address }) });
    expect(reg.status === 400, `relayer /register accepted an http site (${reg.status})`);
    return `${relayerUrl}; /register refuses ${SHOP} as designed (https only)`;
  });

  await step('shop registers (attestor-signed register, as the relayer does for https sites)', async () => {
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const domain = { name: 'Sitebound', version: '1', chainId: 1874, verifyingContract: sb.target };
    const types = { Attest: [{ name: 'siteHash', type: 'bytes32' }, { name: 'to', type: 'address[]' }, { name: 'bps', type: 'uint16[]' }, { name: 'nonce', type: 'uint256' }, { name: 'setId', type: 'uint256' }, { name: 'deadline', type: 'uint64' }] };
    const [setId] = await sb.quorum();
    const sig = Signature.from(await relayer.signTypedData(domain, types, { siteHash, to: [shop.address], bps: [10000], nonce: 0, setId, deadline }));
    await (await sb.register(SHOP, [shop.address], [10000], [[deadline, sig.v, sig.r, sig.s]])).wait();
    const st = await sb.sites(siteHash);
    expect(st.payout === shop.address, `payout on-chain is ${st.payout}`);
    return `${SHOP} -> ${shop.address}`;
  });

  const webPort = await freePort();
  start('python3', ['web/dev/serve.py', String(webPort), String(await freePort())]);
  await waitHttp(`http://127.0.0.1:${webPort}/dev/shop.html`);
  config = `window.SITEBOUND = ${JSON.stringify({
    chainId: 1874, rpcUrl: RPC, explorer: 'http://explorer.invalid', address: sb.target, token: token.target, relayerUrl, relayerFee: '0.01',
  })};\n`;

  browser = await chromium.launch({ executablePath: CHROME, headless: !process.env.E2E_HEADED });
  const context = async (account, inFrames = false) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // Routed pages don't come from a loopback socket, so Chrome 148's Local Network Access treats their calls to
    // anvil and the relayer on 127.0.0.1 as public -> loopback and blocks them. Served by serve.py directly they are
    // loopback -> loopback; in production the RPC is public. Granting the permission undoes the routing artifact.
    // Playwright's 'local-network-access' maps to the older CDP name, so grant 'loopbackNetwork' over CDP.
    const { targetInfo } = await (await ctx.newCDPSession(page)).send('Target.getTargetInfo');
    await (await browser.newBrowserCDPSession()).send('Browser.grantPermissions', { permissions: ['loopbackNetwork'], browserContextId: targetInfo.browserContextId });
    await ctx.route(/^http:\/\/(127\.0\.0\.1:8001|localhost:8002)\//, async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/config.js') return route.fulfill({ contentType: 'text/javascript', body: config });
      return route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:${webPort}${u.pathname}${u.search}` }) });
    });
    await ctx.addInitScript(walletStub, { rpc: RPC, account: account.address, chainId: '0x752', inFrames });
    return { ctx, page };
  };

  // ---------------------------------------------------------------- buyer
  const { ctx: buyerCtx, page } = await context(buyer);
  track('shop', page);
  const shopAuth = await authenticator(page);
  const frame = page.frameLocator('sitebound-pay iframe');
  let credentialHash, passkey;

  await step('buyer opens the shop and the Sitebound frame', async () => {
    await page.goto(`${SHOP}/dev/shop.html`);
    await page.locator('sitebound-pay button.pay').click();
    await frame.locator('#pay').waitFor({ state: 'visible', timeout: 15_000 });
    // The frame first checks the site's registration (up to 5 s) and shows "Checking this website…" meanwhile.
    let msg = '';
    for (let i = 0; i < 40; i++) {
      msg = (await frame.locator('#msg').textContent()).trim();
      if (msg !== 'Checking this website…') break;
      await page.waitForTimeout(200);
    }
    expect(!msg, `frame shows: ${msg}`);
    return `frame says "${(await frame.locator('#line').textContent()).trim()}"`;
  });

  await step('buyer sets up in the popup: passkey, permit, bind via the relayer', async () => {
    const [popup] = await Promise.all([buyerCtx.waitForEvent('page'), frame.locator('#setup').click()]);
    track('setup', popup);
    const popupAuth = await authenticator(popup);
    await popup.locator('#connect').click();
    await until(popup, '#s-caps', '#msg.err', 15_000);
    await popup.locator('#go').click();
    await until(popup, '#finish', '#msg.err', 90_000);
    const creds = await popupAuth.list();
    expect(creds.length === 1, `popup authenticator holds ${creds.length} credentials`);
    passkey = creds[0];
    credentialHash = keccak256(Buffer.from(passkey.credentialId, 'base64'));
    const b = await sb.buyers(credentialHash);
    expect(b.wallet === buyer.address, `buyers(credentialHash).wallet is ${b.wallet}`);
    const allowance = await token.allowance(buyer.address, sb.target);
    expect(allowance === USDT(200), `allowance after permit is ${allowance}`);
    // A popup is another tab, so another virtual authenticator. A platform authenticator (Touch ID, iCloud
    // Keychain) is shared by all tabs, so hand the same credential to the shop tab.
    const copied = !(await shopAuth.list()).some((c) => c.credentialId === creds[0].credentialId);
    if (copied) await shopAuth.add(creds[0]);
    await until(frame, 'p.msg:has-text("Setup complete")', '#msg.err', 10_000);
    return `bound to ${buyer.address}, caps 50/200, allowance 200 USDT${copied ? '; credential copied to the shop tab authenticator' : ''}`;
  });

  await step('buyer pays 12 USDT for A123 with the passkey (relayer)', async () => {
    const before = await Promise.all([bal(buyer.address), bal(shop.address), bal(relayer.address)]);
    await frame.locator('#pay').click();
    await until(frame, '#receipt', '#msg.err', 60_000);
    await page.locator('#log', { hasText: 'sitebound:paid' }).waitFor({ timeout: 10_000 });
    const after = await Promise.all([bal(buyer.address), bal(shop.address), bal(relayer.address)]);
    expect(before[0] - after[0] === USDT(12.01), `buyer moved ${before[0] - after[0]}`);
    expect(after[1] - before[1] === USDT(12), `shop received ${after[1] - before[1]}`);
    expect(after[2] - before[2] === USDT(0.01), `relayer fee ${after[2] - before[2]}`);
    const pm = await sb.payments(paymentId('A123'));
    expect(pm.wallet === buyer.address && pm.amount === USDT(12), `payments(A123) = ${pm}`);
    return 'shop +12, relayer +0.01, buyer -12.01; sitebound:paid reached the shop page';
  });

  await step('buyer pays 12 USDT for A124 from the wallet, via the send.html popup', async () => {
    await frame.locator('#done').click();
    await page.locator('sitebound-pay').evaluate((el) => el.setAttribute('order', 'A124'));
    await page.locator('sitebound-pay button.pay').click();
    await frame.locator('#pay-wallet').click();
    await until(frame, '#continue', '#msg.err', 30_000);
    const [popup] = await Promise.all([buyerCtx.waitForEvent('page'), frame.locator('#continue').click()]);
    track('send', popup);
    await popup.locator('#send:enabled').click({ timeout: 10_000 });
    await until(frame, '#receipt', '#msg.err', 60_000);
    const pm = await sb.payments(paymentId('A124'));
    expect(pm.wallet === buyer.address && pm.amount === USDT(12), `payments(A124) = ${pm}`);
    expect((await bal(shop.address)) === USDT(24), `shop holds ${await bal(shop.address)}`);
    return 'no wallet in the iframe -> Continue -> popup sent pay(); shop holds 24 USDT';
  });

  await step('buyer pays 12 USDT for A125 from a wallet injected into the iframe', async () => {
    const { page: other } = await context(buyer, true);
    track('shop-2', other);
    await (await authenticator(other)).add(passkey);
    await other.goto(`${SHOP}/dev/shop.html`);
    await other.locator('sitebound-pay').evaluate((el) => el.setAttribute('order', 'A125'));
    await other.locator('sitebound-pay button.pay').click();
    const f = other.frameLocator('sitebound-pay iframe');
    await f.locator('#pay-wallet').click();
    await until(f, '#receipt', '#msg.err', 60_000);
    const pm = await sb.payments(paymentId('A125'));
    expect(pm.wallet === buyer.address && pm.amount === USDT(12), `payments(A125) = ${pm}`);
    expect((await bal(shop.address)) === USDT(36), `shop holds ${await bal(shop.address)}`);
    return 'frame sent pay() through window.ethereum directly; shop holds 36 USDT';
  });

  // ---------------------------------------------------------------- shop
  const { page: dash } = await context(shop);
  track('dashboard', dash);

  await step('shop refunds A123 in the dashboard', async () => {
    await dash.goto(`${FRAME}/dashboard/index.html?site=${encodeURIComponent(SHOP)}`);
    // Short printable orders are stored as text (frame/lib.js orderIdOf), so the dashboard shows "A123".
    await dash.locator('button[aria-label="Refund order A123"]').click({ timeout: 20_000 });
    await dash.locator('dialog form button[type="submit"]').click({ timeout: 10_000 });
    await until(dash, 'text=Refund sent', '.notice.error', 60_000);
    const pm = await sb.payments(paymentId('A123'));
    expect(pm.refunded === USDT(12), `refunded on-chain ${pm.refunded}`);
    expect((await bal(buyer.address)) === USDT(100 - 12.01 - 12 - 12 + 12), `buyer holds ${await bal(buyer.address)}`);
    const shown = (await dash.locator('.c-order').allTextContents()).join(', ');
    return `payments(A123).refunded = 12 USDT, back in the buyer wallet; dashboard lists orders as: ${shown}`;
  });

  // ------------------------------------------------------- merchant quotes
  // The shop's backend key (merchantKey) signs the quote with web/merchant/sitebound-merchant.mjs; the page only
  // carries the result in <sitebound-pay quote="...">.
  const quoteFor = (order, amount) => M.signQuote(merchantKey, {
    chainId: 1874, contract: sb.target, token: token.target, site: SHOP, order, amount: String(amount), expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  const openCheckout = async (attrs) => {
    if (await frame.locator('#done').isVisible().catch(() => false)) await frame.locator('#done').click();
    else if (await frame.locator('#close').isVisible().catch(() => false)) await frame.locator('#close').click();
    await page.locator('sitebound-pay').evaluate((el, a) => { for (const [k, v] of Object.entries(a)) v == null ? el.removeAttribute(k) : el.setAttribute(k, v); }, attrs);
    await page.locator('sitebound-pay button.pay').click();
    await frame.locator('#pay').waitFor({ state: 'visible', timeout: 15_000 });
  };

  // Before quotes are on: the demo shop sends no quote.
  await step('demo shop: a forged paid event is not shipped, a passkey payment is confirmed on chain', async () => {
    await page.goto(`${SHOP}/demo-shop/`);
    await page.locator('#products .card button').first().click(); // Ceramic pour-over dripper, 12.00
    await page.locator('#checkout').click();
    await page.locator('#forge').click();
    await page.locator('#done-title', { hasText: 'Not shipped' }).waitFor({ timeout: 15_000 });
    const forged = (await page.locator('#done-text').textContent()).trim();
    await page.locator('#again').click();
    await page.locator('#checkout').click();
    const order = (await page.locator('#order-id').textContent()).trim();
    const shopBefore = await bal(shop.address);
    await page.locator('sitebound-pay button.pay').click();
    await frame.locator('#pay').waitFor({ state: 'visible', timeout: 15_000 });
    await frame.locator('#pay').click();
    // On sitebound:paid the shop hides its pay panel, frame included, so wait on the shop's own verdict.
    await page.locator('#done-title', { hasText: /Order confirmed|Not shipped/ }).waitFor({ timeout: 60_000 });
    const title = (await page.locator('#done-title').textContent()).trim();
    const text = (await page.locator('#done-text').textContent()).trim();
    expect(title === 'Order confirmed', `demo shop says ${title}: ${text}`);
    expect((await bal(shop.address)) - shopBefore === USDT(12), 'the shop was not paid 12');
    await page.goto(`${SHOP}/dev/shop.html`);
    return `forged: "${forged}"; real ${order}: "${text}"`;
  });

  await step('shop turns on merchant quotes; a quoted payment pays A126', async () => {
    const v = await sb.configVersion(siteHash);
    await (await sb.connect(await provider.getSigner(shop.address)).setQuoteSigner(siteHash, merchantKey.address)).wait();
    await provider.send('evm_increaseTime', [61]);
    await provider.send('evm_mine', []);
    expect((await sb.configVersion(siteHash)) === v + 2n, 'configVersion did not count the set and the activation');
    await openCheckout({ order: 'A126', amount: '12.00', quote: await quoteFor('A126', 12) });
    await frame.locator('#pay').click();
    await until(frame, '#receipt', '#msg.err', 60_000);
    const pm = await sb.payments(paymentId('A126'));
    expect(pm.wallet === buyer.address && pm.amount === USDT(12), `payments(A126) = ${pm}`);
    return 'setQuoteSigner live after 61 s; the frame passed the quote to the relayer, payWithQuote paid 12 USDT';
  });

  await step('merchant helper: verifyPayment accepts A126 and refuses wrong claims', async () => {
    const base = { provider, contract: sb.target, expectedSite: SHOP };
    const good = await M.verifyPayment({ ...base, expectedAmount: '12.00', orderId: 'A126', paymentId: paymentId('A126') });
    expect(good.ok && good.wallet === buyer.address && good.amount === USDT(12), `A126: ${good.reason}`);
    const bad = {
      'wrong amount': await M.verifyPayment({ ...base, expectedAmount: '13.00', orderId: 'A126' }),
      'paymentId of another order': await M.verifyPayment({ ...base, expectedAmount: '12.00', orderId: 'A126', paymentId: paymentId('A125') }),
      'unpaid order': await M.verifyPayment({ ...base, expectedAmount: '12.00', orderId: 'A999' }),
      'refunded order': await M.verifyPayment({ ...base, expectedAmount: '12.00', orderId: 'A123' }),
      'another site': await M.verifyPayment({ ...base, expectedSite: 'https://evil.example', expectedAmount: '12.00', orderId: 'A126' }),
    };
    for (const [k, r] of Object.entries(bad)) expect(!r.ok, `${k} was accepted`);
    return Object.entries(bad).map(([k, r]) => `${k}: "${r.reason}"`).join('; ');
  });

  await step('a page that changes the amount to 13 with the 12 USDT quote does not get paid (A127)', async () => {
    await openCheckout({ order: 'A127', amount: '13.00', quote: await quoteFor('A127', 12) });
    await frame.locator('#pay').click();
    const err = frame.locator('#msg.err');
    await err.waitFor({ state: 'visible', timeout: 60_000 });
    const text = (await err.textContent()).trim();
    expect(/quote/i.test(text), `frame says: ${text}`);
    const pm = await sb.payments(paymentId('A127'));
    expect(pm.wallet === ZeroAddress, `payments(A127) = ${pm}`);
    await openCheckout({ order: 'A128', amount: '12.00', quote: null }); // no quote at all
    await frame.locator('#pay').click();
    await err.waitFor({ state: 'visible', timeout: 60_000 });
    const text2 = (await err.textContent()).trim();
    expect(/quote required/i.test(text2), `frame says: ${text2}`);
    return `frame says "${text}"; without a quote: "${text2}"; nothing paid`;
  });
}

let failed = false;
try {
  await main();
  console.log('\nall steps passed');
} catch (e) {
  failed = true;
  if (!(e instanceof Stop)) console.log(`crashed: ${say(e)}`);
  console.log(`\nstopped at the step above; screenshots in ${OUT}`);
} finally {
  await browser?.close().catch(() => {});
  for (const p of procs) p.kill();
  rmSync(BUILD, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
