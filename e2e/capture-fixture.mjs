// Captures a real Chromium WebAuthn assertion from a cross-origin iframe, for SiteboundV2's challenge, and writes
// test/fixtures/frame_assertion_v2.json. Chrome builds clientDataJSON (with crossOrigin and topOrigin) and
// authenticatorData itself; a CDP virtual authenticator holds a P-256 key generated here, so pubX/pubY are known.
// The top page (http://127.0.0.1:8001) and the frame (http://localhost:8002) are routed inside the browser, so
// nothing listens on those ports. Run: cd e2e && node capture-fixture.mjs. Env: CHROME=<binary>.
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbiCoder, encodeBytes32String, getBytes, hexlify, keccak256, sha256, toUtf8Bytes } from 'ethers';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || join(os.homedir(),
  'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const TOP = 'http://127.0.0.1:8001';
const FRAME = 'http://localhost:8002';

// What the Foundry test sets up: SiteboundV2 placed at `contract` on chain 1874, TOP registered once (version 1).
const fx = {
  chainId: 1874,
  contract: '0x51b0b00000000000000000000000000000000002',
  topOrigin: TOP,
  frameOrigin: FRAME,
  rpId: 'localhost',
  configVersion: 1,
  orderId: encodeBytes32String('fixture-2'),
  amount: 12_000_000,
  relayerFee: 0,
  deadline: 4_102_444_800, // 2100-01-01
};
fx.challenge = keccak256(AbiCoder.defaultAbiCoder().encode(
  ['uint256', 'address', 'bytes32', 'uint256', 'bytes32', 'uint256', 'uint256', 'uint256'],
  [fx.chainId, fx.contract, keccak256(toUtf8Bytes(TOP)), fx.configVersion, fx.orderId, fx.amount, fx.relayerFee, fx.deadline],
));

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' });
const credId = randomBytes(32);

const top = `<!doctype html><title>top</title><iframe src="${FRAME}/" allow="publickey-credentials-get *" width="400" height="200"></iframe>`;
const frame = `<!doctype html><title>frame</title><button id="go">Sign</button><pre id="out"></pre><script>
const hex = (b) => '0x' + [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
document.getElementById('go').onclick = async () => {
  try {
    const c = await navigator.credentials.get({ publicKey: {
      rpId: 'localhost', challenge: Uint8Array.from(${JSON.stringify([...getBytes(fx.challenge)])}),
      userVerification: 'required', allowCredentials: [], timeout: 10000 } });
    document.getElementById('out').textContent = JSON.stringify({
      rawId: hex(c.rawId),
      clientDataJSON: new TextDecoder().decode(c.response.clientDataJSON),
      authenticatorData: hex(c.response.authenticatorData),
      signature: hex(c.response.signature),
    });
  } catch (e) { document.getElementById('out').textContent = 'ERR ' + e.name + ': ' + e.message; }
};
</script>`;

const browser = await chromium.launch({ executablePath: CHROME, headless: !process.env.E2E_HEADED });
try {
  const ctx = await browser.newContext();
  await ctx.route(/^http:\/\/(127\.0\.0\.1:8001|localhost:8002)\//, (route) =>
    route.fulfill({ contentType: 'text/html', body: route.request().url().startsWith(TOP) ? top : frame }));
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: {
    credentialId: credId.toString('base64'), isResidentCredential: true, rpId: 'localhost',
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    userHandle: Buffer.from('fixture').toString('base64'), signCount: 1,
  } });
  await page.goto(`${TOP}/`);
  const f = page.frameLocator('iframe');
  await f.locator('#go').click();
  await f.locator('#out:not(:empty)').waitFor({ timeout: 15_000 });
  const text = await f.locator('#out').textContent();
  if (text.startsWith('ERR')) throw new Error(text);
  const got = JSON.parse(text);

  const cd = JSON.parse(got.clientDataJSON);
  const b64 = Buffer.from(getBytes(fx.challenge)).toString('base64url');
  if (cd.challenge !== b64 || cd.origin !== FRAME || cd.crossOrigin !== true || cd.topOrigin !== TOP)
    throw new Error(`unexpected clientDataJSON ${got.clientDataJSON}`);
  if (got.rawId !== hexlify(credId)) throw new Error('the assertion used another credential');
  const signed = Buffer.concat([getBytes(got.authenticatorData), getBytes(sha256(toUtf8Bytes(got.clientDataJSON)))]);
  const der = Buffer.from(getBytes(got.signature));
  if (!verify("sha256", signed, publicKey, der)) throw new Error('signature does not verify');

  // DER SEQUENCE { INTEGER r, INTEGER s }
  const rl = der[3], sl = der[5 + rl];
  const int = (b) => '0x' + BigInt('0x' + b.toString('hex')).toString(16).padStart(64, '0');
  const out = {
    source: `${await browser.version()} (Chromium), CDP virtual authenticator (ctap2, internal, UV), cross-origin iframe; e2e/capture-fixture.mjs`,
    ua: await page.evaluate(() => navigator.userAgent),
    topOrigin: TOP, frameOrigin: FRAME, rpId: fx.rpId,
    credId: got.rawId,
    pubX: '0x' + Buffer.from(jwk.x, 'base64url').toString('hex'),
    pubY: '0x' + Buffer.from(jwk.y, 'base64url').toString('hex'),
    authenticatorData: got.authenticatorData,
    clientDataJSON: got.clientDataJSON,
    r: int(der.subarray(4, 4 + rl)), s: int(der.subarray(6 + rl, 6 + rl + sl)),
    chainId: fx.chainId, contract: fx.contract, configVersion: fx.configVersion, orderId: fx.orderId,
    amount: fx.amount, relayerFee: fx.relayerFee, deadline: fx.deadline, challenge: fx.challenge,
  };
  writeFileSync(join(ROOT, 'test/fixtures/frame_assertion_v2.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote test/fixtures/frame_assertion_v2.json: ${got.clientDataJSON}`);
} finally {
  await browser.close();
}
