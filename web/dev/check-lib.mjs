// Feeds the real Chromium assertion (test/fixtures/frame_assertion.json) through web/frame/lib.js.
// Run from the repo root: node web/dev/check-lib.mjs
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
globalThis.ethers = require('../vendor/ethers-6.17.0.umd.min.js');
const L = await import('../frame/lib.js');
const { ethers } = globalThis;
const fx = JSON.parse(readFileSync(new URL('../../test/fixtures/frame_assertion.json', import.meta.url)));
const ok = (m) => console.log('ok  ', m);

const siteHash = L.siteHashOf(fx.topOrigin);
const challenge = L.challengeOf({ chainId: fx.chainId, address: fx.contract, siteHash, orderId: fx.orderId, amount: fx.amount, relayerFee: fx.relayerFee, deadline: fx.deadline });
assert.equal(challenge, fx.challenge);
ok(`challenge ${challenge}`);
assert.equal(ethers.hexlify(ethers.toUtf8Bytes('fixture-1')).padEnd(66, '0'), fx.orderId);
ok('fixture orderId is bytes32("fixture-1") (the frame uses keccak256(order) instead)');

assert.equal(JSON.parse(fx.clientDataJSON).challenge, L.b64url(challenge));
ok('b64url(challenge) equals the challenge Chrome wrote into clientDataJSON');
L.checkClientData(fx.clientDataJSON, { challenge, frameOrigin: fx.frameOrigin, topOrigin: fx.topOrigin });
ok('checkClientData accepts the fixture');
assert.throws(() => L.checkClientData(fx.clientDataJSON, { challenge, frameOrigin: fx.frameOrigin, topOrigin: 'https://evil.example' }));
ok('checkClientData rejects a different topOrigin');

const offs = L.offsetsOf(fx.clientDataJSON);
const solFind = (k) => fx.clientDataJSON.indexOf(k); // Sitebound.t.sol _find: first byte match
assert.deepEqual(offs, {
  typeIdx: solFind('"type":'), challengeIdx: solFind('"challenge":'), originIdx: solFind('"origin":'),
  crossOriginIdx: solFind('"crossOrigin":'), topOriginIdx: solFind('"topOrigin":'),
});
ok(`offsets ${JSON.stringify(offs)} match the test's _find`);
const tricky = '{"x":"type":0,"type":"webauthn.get","challenge":"","origin":"","crossOrigin":true,"topOrigin":""}';
assert.equal(L.offsetsOf(tricky).typeIdx, tricky.indexOf(',"type":') + 1);
ok('offsets skip a key that is not after { or ,');

const derLog = new URL('../../spikes/frame-probe/log.jsonl', import.meta.url);
const logged = existsSync(derLog) ? readFileSync(derLog, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : [];
const der = logged.find((o) => o.r === fx.r.slice(2))?.signatureDer;
if (der) {
  const { r, s } = L.derToRS('0x' + der);
  assert.equal(r, BigInt(fx.r)); assert.equal(s, BigInt(fx.s));
  ok('derToRS(real Chrome DER) equals fixture r,s');
} else console.log('skip derToRS real DER (spikes/frame-probe/log.jsonl absent)');
const short = L.derToRS('0x3044021f' + '11'.repeat(31) + '0221' + '00' + 'ff'.repeat(32));
assert.equal(short.r, BigInt('0x' + '11'.repeat(31))); assert.equal(short.s, BigInt('0x' + 'ff'.repeat(32)));
ok('derToRS handles a 31-byte r and a 0x00-padded s');
assert.throws(() => L.derToRS('0x3044021f00'));
ok('derToRS rejects a truncated DER');

const spki = logged.find((o) => o.step === 'create' && o.credId === fx.credId.slice(2))?.spki;
if (spki) {
  const { x, y } = L.pubKeyXY('0x' + spki);
  assert.equal(x, BigInt(fx.pubX)); assert.equal(y, BigInt(fx.pubY));
  ok('pubKeyXY(real SPKI) equals fixture pubX,pubY');
} else console.log('skip pubKeyXY real SPKI (log absent)');

const key = await crypto.subtle.importKey('raw', ethers.getBytes(ethers.concat(['0x04', fx.pubX, fx.pubY])), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
const cdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fx.clientDataJSON)));
const signed = ethers.getBytes(ethers.concat([fx.authenticatorData, cdHash]));
const sig = ethers.getBytes(ethers.concat([ethers.toBeHex(BigInt(fx.r), 32), ethers.toBeHex(BigInt(fx.s), 32)]));
assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, signed));
ok('WebCrypto P-256 verifies the fixture over authData || sha256(clientDataJSON)');

const input = L.payInputOf({ rawId: fx.credId, authenticatorData: fx.authenticatorData, clientDataJSON: fx.clientDataJSON, signature: '0x3046022100' + fx.r.slice(2) + '022100' + fx.s.slice(2), orderId: fx.orderId, amount: BigInt(fx.amount), relayerFee: 0n, deadline: BigInt(fx.deadline) });
assert.equal(input.credentialHash, ethers.keccak256(fx.credId));
assert.equal(input.r, BigInt(fx.r));
const iface = new ethers.Interface(L.SITEBOUND_ABI);
assert.equal(iface.getFunction('pay').selector, ethers.id('pay((bytes32,bytes,string,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes32,uint256,uint256,uint256))').slice(0, 10));
iface.encodeFunctionData('pay', [JSON.parse(L.jsonOf(input))]);
ok('payInputOf -> JSON -> pay() calldata encodes (selector matches the ABI signature)');

assert.equal(ethers.TypedDataEncoder.from(L.BIND_TYPES).encodeType('Bind'),
  'Bind(bytes32 credentialHash,uint256 pubX,uint256 pubY,uint256 perPayCap,uint256 totalCap,uint64 expiry,uint256 nonce)');
assert.equal(ethers.TypedDataEncoder.from(L.PERMIT_TYPES).encodeType('Permit'),
  'Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)');
ok('Bind and Permit type strings match the contract / EIP-2612');
assert.equal(L.paymentIdOf(siteHash, fx.orderId), ethers.keccak256(ethers.concat([siteHash, fx.orderId])));
assert.equal(L.errText(new Error('fetch https://rpc.example/v2/SECRET failed')), 'fetch [url] failed');
ok('paymentId and error redaction');
console.log('all checks passed');
