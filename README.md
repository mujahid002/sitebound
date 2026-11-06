# Sitebound

Sitebound removes the payment address from checkout. A website registers its payout wallet once (a DNS TXT record
proves it owns the domain). The buyer approves the website and the amount with a passkey. The contract checks the
browser-signed site and pays only that site's registered wallet. Compromised checkout JavaScript can change the page,
not who gets paid.

This defends against **recipient substitution**: hacked code on a real website swapping who gets paid. It is not
phishing protection. A lookalike domain that registers its own wallet is a separate threat; the fake-site demo shows
it, along with the overlay limit. Full trust model: [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

Built for ETHGlobal Mumbai (Nov 2026) on Whitechain Sepolia testnet. Not audited. The code on `main` is SiteboundV2
(`src/SiteboundV2.sol`), live at `0x64117398C837a8708a816818b31C36Df5a968596`. v1 (`src/Sitebound.sol`) is deprecated.

## The problems

1. **Hacked checkout code swaps addresses.** The website's address lives in its checkout JavaScript. One
   compromised dependency rewrites it (on the page or in the clipboard) and the money goes to the attacker.
   The npm "qix" package compromise in Sep 2025 rewrote crypto recipients this way.
2. **Addresses are bad checkout UX.** Websites paste and manage an address per chain. Buyers copy, paste or scan
   one and have to compare 40 hex characters they can't read.
3. **Crypto has no 3-D Secure.** Card buyers get a confirmation step from their bank that shows the merchant and
   the amount. Crypto buyers sign raw transactions.

## How it works

- **Website, once.** It proves it controls its domain with a DNS TXT record (`_sitebound.<host>` =
  `sitebound=<payout>`). Attestors check the record and sign, and anyone can submit `register()`.
  - The registry maps `keccak256("https://example.com")` to the website's payout split.
  - The contract needs `threshold` signatures from the active attestor set. The deployment is 1-of-1, with the
    relayer as the only attestor.
  - The website pastes one script tag and a `<sitebound-pay amount="12.00" order="A123">` element. There is no
    address in its code.
  - The onboarding wizard creates the payout wallet in the browser: no extension, no gas. It shows a 12-word recovery
    phrase once and keeps the wallet in that browser. "I already have a wallet" connects MetaMask or Rabby instead.
- **Buyer, first time.** In a popup on the Sitebound origin, the buyer:
  - connects a wallet;
  - signs a capped EIP-2612 permit;
  - signs an EIP-712 binding: passkey public key, per-payment cap, total cap and expiry;
  - creates a passkey.

  One passkey is bound to one wallet.
- **Buyer, every payment.** The button opens the Sitebound frame in a cross-origin iframe. The frame shows the site
  (from `location.ancestorOrigins`) and the amount, then calls WebAuthn `get()`. One Touch ID signs one exact
  payment: site, the site's config version, order id, amount, relayer fee and deadline. The buyer pays USDT
  (the amount plus a 0.01 USDT relayer fee), never gas: the relayer pays the WBT.
- **Contract.** Chrome writes the embedding page's origin into the signed `clientDataJSON` as `topOrigin`, and page
  code can't change it. `pay()`:
  - checks the passkey signature with the P-256 precompile at `0x100`;
  - checks that the signature came from the Sitebound frame (`origin`, `crossOrigin:true`);
  - moves USDT from the buyer's wallet to the split registered for `keccak256(topOrigin)`.

  There is no payee field in the call.

**Why on-chain settlement:** the site check runs in the same contract that moves the money, so hacked checkout code
can't redirect it. An off-chain processor can't give the buyer that guarantee.

## Website settings (SiteboundV2)

The first wallet of a site's split is its **owner**. Every change below bumps the site's config version. The
buyer's passkey signs that version, so a payment signed before a change cannot execute after it.

- **Split payouts.** Up to 5 wallets, in basis points summing to 10000. The owner gets the rounding dust. Changing
  the split needs the attestors and waits `delay` (1 hour on the deployment).
- **Drop a recipient.** The owner can remove a non-owner recipient at once, for example one the token refuses to pay.
  Its share goes to the owner.
- **Refund operator, admins (up to 3), quote signer.** The owner sets each one and it takes effect after `delay`.
  Removing an admin is immediate. When the split moves to a new owner, all of them are cleared.
- **Refunds** go only to the wallet that paid, and are paid from the refunder's own funds. The total is capped at
  the payment's amount; the relayer fee is not refundable.
- **Freeze.** The owner's freeze stops payments and split changes until the owner lifts it. An admin's freeze stops
  payments for 72 hours and cannot cancel a pending split.
- **Guardian.** It is fixed at deploy (optional) and can pause new payments. It cannot move funds or stop refunds.

## Verify on your server before shipping

The `sitebound:paid` event comes from the page, and any script on the page can fire it. Before you ship, ask the
chain. `web/merchant/sitebound-merchant.mjs` runs in Node with ethers v6 (`npm install ethers@6`, then copy the file):

```js
import { verifyPayment } from './sitebound-merchant.mjs';

const r = await verifyPayment({
  rpcUrl: 'https://rpc.testnet.whitechain.io',
  contract: SITEBOUND_ADDRESS,
  expectedSite: 'https://site.example', // your origin, exactly as the browser reports it
  expectedAmount: '12.00',              // your price for this order, not the page's
  orderId: 'A123',
  paymentId: fromTheBrowser,            // optional: only compared, never trusted
});
if (!r.ok) throw new Error(`not paid: ${r.reason}`);
```

It recomputes the payment id from your site and order, then reads `payments(id)` on chain. It requires a payer, your
site, the exact amount, and nothing refunded. Use random order ids: anyone can pay an unused one at their own cost.
In e2e it accepts a real payment and refuses five wrong claims: a different amount, another order's id, an unpaid
order, a refunded order, and another site. The demo site runs the same check in the page (a real website runs it on
its server): a forged `sitebound:paid` gets "Not shipped", a real payment "Order confirmed".

### Merchant quotes (optional)

Without a quote, hacked page code can ask the buyer for a different amount, and only the buyer reading the frame
stops it. A site can name a **quote signer** (`setQuoteSigner`, takes effect after `delay`). From then on every
payment must carry a quote that the site's backend signs for that site, order and amount:

```js
import { Wallet } from 'ethers';
import { signQuote } from './sitebound-merchant.mjs';

const quote = await signQuote(new Wallet(process.env.SITEBOUND_QUOTE_KEY), {
  chainId: 1874, contract: SITEBOUND_ADDRESS, token: USDT_ADDRESS,
  site: 'https://site.example', order: 'A123', amount: '12.00', // expires in 15 minutes by default
});
// <sitebound-pay amount="12.00" order="A123" quote="${quote}"></sitebound-pay>
```

A page that changes the amount gets "bad quote", and one without a quote gets "quote required" (both in e2e). The
quote signer can be a contract wallet (ERC-1271).

## Architecture

| Part | Path | What it does |
|---|---|---|
| Contract | `src/SiteboundV2.sol` | Site registry with splits and site roles, k-of-n attestors, passkey bindings with caps, `pay()`, refunds. Deprecated v1: `src/Sitebound.sol`. |
| Frame | `web/frame/` | Checkout iframe (`get()` only) and the first-time setup popup. Vanilla JS and vendored ethers 6.17.0. |
| Button | `web/button/sitebound.js` | The `<sitebound-pay>` element. It opens the frame from its own host and fires `sitebound:paid`. |
| Merchant helper | `web/merchant/sitebound-merchant.mjs` | `verifyPayment` and `signQuote`, for the website's server. |
| Relayer (optional) | `worker/` | Cloudflare Worker. It pays gas for `register`, `permit`, `bind` and `pay`, and is also the DNS attestor. See `worker/README.md`. |
| Onboarding | `web/onboard/` | Website setup: payout wallet (created in the browser or your own), DNS TXT check, register, snippet. |
| Dashboard | `web/dashboard/` | Payments to one site from chain events, refunds, CSV. |
| Receipt | `web/receipt/` | One payment's receipt, read from the chain: `/receipt/?id=<paymentId>` or `?tx=<hash>`. |
| Pay link | `web/pay/` | Builds a standalone pay page for the owner's own origin. |
| Landing | `web/landing/` | The public page, served at the site root. |
| Demo site | `web/demo-shop/` | A site whose checkout is only the `<sitebound-pay>` element. |
| Attack demos | `web/attack/` | An address swap on a classic checkout, the same script against Sitebound, and a fake site embedding the frame. |

The relayer only pays gas. `pay()` is permissionless and the payee comes from the registry, so a relayer can refuse
a payment but can't redirect one. The frame also offers "Pay from my wallet": the buyer submits `pay()` with
`relayerFee = 0` and pays gas in WBT.

## Setup and local dev

Requires Foundry, Node, Python 3 and Chrome (the only browser measured so far).

```sh
forge install foundry-rs/forge-std   # lib/ is not committed
forge test                           # v1, SiteboundV2 and the V2 invariant suites
node web/dev/check-lib.mjs           # the frame's encoders and the merchant helper, on the real Chrome fixture
(cd worker && npm install && node test/local.mjs)  # relayer against anvil, then under wrangler dev
(cd e2e && npm install && npm test)                # headless Chromium: setup, pay, refund, demo site, quotes
```

`forge test` has no P-256 precompile, so the tests etch a Solidity verifier (`test/utils/P256Verifier.sol`) at
`0x100`. One test replays a real Chromium assertion from a cross-origin iframe
(`test/fixtures/frame_assertion_v2.json`, captured by `e2e/capture-fixture.mjs`). e2e expects Chrome for Testing
from Playwright's cache, or `CHROME=<binary>`.

To run the web pages locally (the site and the frame must be different origins):

```sh
python3 web/dev/serve.py
# site  http://127.0.0.1:8001   (web/ served with no-store)
# frame http://localhost:8002   (the same web/ folder, a different origin)
```

- Demo site: http://127.0.0.1:8001/demo-shop/
- Attack demos: http://127.0.0.1:8001/attack/. For the fake-site page, serve `web/` on a third origin too:
  `python3 -m http.server 8003 --bind 127.0.0.1 --directory web`, then open http://127.0.0.1:8003/attack/phish.html.
- Local passkeys use rpId `localhost`, so the frame must be on `localhost`.
- `web/config.js` holds the chain id, RPC, explorer, contract address and relayer URL for the frame.

Hosting: `deploy/pages.sh` deploys the frame host, the demo site and the fake-site copy to Cloudflare Pages (needs
`wrangler login`). A real website loads the button from the frame host, because the button opens the frame next to
its own script URL.

### Deploy the contract

```sh
ATTESTORS=<addresses, comma-separated, ascending> THRESHOLD=1 \
FRAME_ORIGIN=https://<frame host> RP_ID=<frame host> DELAY=3600 GUARDIAN=<optional> \
  forge script script/Deploy.s.sol --rpc-url $RPC_URL --account <keystore> --broadcast
```

The token is Whitechain Sepolia USDT `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` (6 decimals, so the on-chain
relayer fee cap is 1 USDT). `DELAY` must be 1 s to 30 days. After a V2 deploy:
- point `web/config.js` and `worker/wrangler.toml` at it;
- fill in `web/verify/expected.json`;
- register the sites again.

Buyers set up again too: v1 bindings and allowances do not carry over.

## Add a website without DNS (demo/admin only)

For the demo, the relayer can add any website without a DNS record. This is off unless the Worker has the
`ADMIN_TOKEN` secret.

```sh
sh scripts/add-site.sh https://site.example 0xPayoutAddress   # prints the register tx hash and an explorer link
```

- The script stores the payout in the relayer's KV (`POST /admin/sites` with `Authorization: Bearer $ADMIN_TOKEN`),
  then calls `/register`. The relayer signs the same attestation it signs for a DNS-verified site.
- It reads `ADMIN_TOKEN` from the environment or `.env`. `GET /admin/sites` lists the added sites.
  `DELETE /admin/sites` with `{"site": ...}` removes one; the on-chain registration stays.
- The relayer checks `DEMO_SITES` first, then these entries, then DNS. An entry overrides the site's DNS record until
  it is deleted.
- Whoever holds the token can register any website: the power the relayer's attestor key already has. See
  [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## Deployments (Whitechain Sepolia, chain 1874)

- SiteboundV2 (live): [`0x64117398C837a8708a816818b31C36Df5a968596`](https://explorer.testnet.whitechain.io/address/0x64117398C837a8708a816818b31C36Df5a968596?tab=contract)
  - Deploy tx `0xc54c53e26ecfaeac2b85b712ce52096f5f7f264d620b1d9635f2acde3f0446d5`, block 12,389,848, built from
    commit 100c615.
  - Token: Whitechain USDT. `DELAY` 1 hour. Frame origin `https://sitebound-pay.pages.dev`.
  - One attestor, the relayer `0xDf54063Eb6FEF689965d470c6b5aab0489eA5b4A`, threshold 1.
  - No guardian (`address(0)`), so no one can pause it.
  - Measured on chain 23:02 to 23:07 IST, 6 Nov.
- Deprecated v1 Sitebound, superseded by V2: [`0x43bb27f7079c76D6F0Fa4b4e6d69843e0457DF73`](https://explorer.testnet.whitechain.io/address/0x43bb27f7079c76D6F0Fa4b4e6d69843e0457DF73). Its sites, bindings and
  allowances do not carry over.
- Frame, landing, onboarding, dashboard: https://sitebound-pay.pages.dev
- Demo site: https://sitebound-demo.pages.dev
- Real-domain demo: https://0xmujahid.xyz, the owner's portfolio with a "Buy me a coffee" section (3, 5 or 10 USDT)
  that uses the `<sitebound-pay>` button (`web/portfolio/index.html`). Registered on chain: not checked.
- Relayer Worker: https://sitebound-relayer.sitebound-relayer.workers.dev (`/health`)
- First USDT payment: TBD
- Explorer: https://explorer.testnet.whitechain.io

## Verify it yourself

There are three independent ways to check that a deployed contract is the code in this repo. The build is solc
0.8.28, via-IR, optimizer 200 runs, EVM cancun, and the expected values are in `web/verify/expected.json`.

- **From source, on your machine:** `sh scripts/verify.sh`.
  - It rebuilds with `forge`, reads the deployed code with `cast`, zeroes the immutables in both, and compares.
  - SiteboundV2 has five immutables: token, rpIdHash, delay, maxRelayerFee and guardian. With no arguments it checks
    the live V2 and prints `MATCH 0xc9c9a99f74a8066af413321ad482f1aa0da0a9620ba248423284edd25b1c49e6` (measured 6 Nov,
    23:02 IST).
  - For v1: `CONTRACT=Sitebound ADDRESS=0x43bb27f7079c76D6F0Fa4b4e6d69843e0457DF73 sh scripts/verify.sh` prints
    `MATCH 0xaa7fc4f738a41cc4ff55b7dfc84353a4ee48244e2074ddbdeecab73c19633f1f` (measured 6 Nov, 22:50 IST).
  - It needs only Foundry; the public RPC is the default.
- **Sourcify and the Whitechain explorer.**
  - Sourcify reports an exact match for the creation and the runtime code of both versions.
    - V2: https://repo.sourcify.dev/1874/0x64117398C837a8708a816818b31C36Df5a968596 (verified 23:00:50 IST, 6 Nov).
    - Deprecated v1: https://repo.sourcify.dev/1874/0x43bb27f7079c76D6F0Fa4b4e6d69843e0457DF73
  - The explorer shows V2's verified source: https://explorer.testnet.whitechain.io/address/0x64117398C837a8708a816818b31C36Df5a968596?tab=contract (name SiteboundV2, solc v0.8.28, verified 23:00:53
    IST).
- **In your browser:** "Verify us" on https://sitebound-pay.pages.dev/#verify reads the code with `eth_getCode`,
  applies the same masking, and compares the hash with `web/verify/expected.json`. It also checks that the
  immutables baked into the code are the values that file lists.

The deprecated v1 is still unverified on the explorer (`is_verified: false` at 23:06 IST, 6 Nov). Our v1
submissions earlier on 6 Nov ended in "Fail - Unable to verify". That history is in WHITECHAIN_FEEDBACK.md. For the
standard-JSON input, run `forge verify-contract --show-standard-json-input`.

## Threat model (summary)

The full version, with line references, is [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

- **Stops:** hacked checkout JavaScript on the real website redirecting a payment. A fake site embedding the frame
  can only pay its own registry entry.
- **Does not stop:**
  - a lookalike domain that registered its own wallet;
  - a page drawn over the frame (UI redressing);
  - a hacked page asking for a different amount, unless the site uses quotes.
- **Trusted:**
  - the attestors' DNS check. 1-of-1 is one trusted authority, not decentralized; rotation at k = 1 adds no safety;
  - the frame host's code;
  - the buyer's browser;
  - the guardian, for liveness only;
  - the USDT issuer.
- **Relayer only:** the daily caps and the minimum fee are enforced by the relayer, not on-chain.
- **Owner key:** a stolen owner key can freeze a site permanently.
- **Browsers:** Safari may omit `topOrigin` (not measured), and a missing `topOrigin` fails closed. Firefox: not
  checked.

## CROPS notes

- **No contract owner and no upgrade path.**
  - Token, frame origin, RP ID, delay, fee cap and guardian are fixed in the constructor.
  - It is not "no admin": each site has an owner and optional admins, the attestor set can rotate (quorum plus
    `delay`), and a guardian, if set, can pause new payments.
- **Permissionless `pay()`.** Anyone can relay and earn the signed fee, or the buyer submits it from their own
  wallet with no fee.
- **Trusted roles, bounded.**
  - The attestors can register sites, and change a site's split only after `delay`, while the owner can freeze.
  - The deployed 1-of-1 set is one key, held by the relayer.
  - Roadmap: an on-chain DNSSEC proof instead of the attestor.
- **Walkaway.** The contract never holds funds; each payment moves wallet to payout in one transaction. If we
  disappear, buyers revoke with `unbind()` or `approve(0)`, and websites keep what they were paid. Refunds keep
  working while payments are paused.
- **Self-hostable.** The frame origin is a constructor argument: anyone can host their own frame and deploy their
  own instance. The RPC is configurable. No analytics.
- **Privacy: No.** Wallet, credential hash, site and amount of every payment are public.
- **License:** MIT.

## Prior art and what is new

- [Secure Payment Confirmation](https://www.w3.org/TR/secure-payment-confirmation/) (W3C, Chrome): a WebAuthn
  assertion for payments whose signed data includes `topOrigin`, the payee's origin and the amount. The bank, as the
  relying party, verifies it off-chain. Sitebound uses the same idea, a browser-signed top-level origin, but checks it
  in the contract that moves the money.
- [RIP-7212](https://github.com/ethereum/RIPs/blob/master/RIPS/rip-7212.md): the P-256 precompile at `0x100`. It
  lets the contract verify every passkey signature on-chain. Whitechain Sepolia has it (see WHITECHAIN_FEEDBACK.md).
- [anandh8x/payeelock](https://github.com/anandh8x/payeelock): Confirmation of Payee for invoices, with a DNS-TXT
  verifier, a domain attestor and an on-chain payee registry. It has no passkeys and no binding to the browser's
  origin.
- On-chain WebAuthn verifiers (Solady, base/webauthn-sol) verify the signature but not `topOrigin`.

Payment contracts on Whitechain Sepolia, read from their verified source on 6 Nov:

| Contract | How the payee is chosen |
|---|---|
| PayKit PaymentRouterV2 `0xb3BA…1c57`, MerchantRegistry `0xF6B6…6C47` | The registry's split for the merchant id named in a merchant-signed quote. The registry also stores an attestor-written domain flag, but the router never reads it. It has installment plans. |
| AuthCaptureEscrow `0xAA32…2398` (Coinbase-style) | The `receiver` in the operator's PaymentInfo; only the operator can act. |
| ZyuraCheckout `0x1346…D7C5` | `intent.merchant`, signed by the merchant's signer. Funds are held and withdrawn to the payout account. |
| SettleKitPayments `0xD59E…299d` | The `merchant` argument to `pay()`, on an intent signed by an owner-set signer. |
| GraphPayCheckout `0x7523…6FcA` | `o.merchant` in a relayer-only `settleOrder`. It has subscriptions. |
| HundiVault `0x422D…c45A` | P-256-signed offline notes; settle pays the note's `payTo`. |

None of the 8 source files read (the seven contracts above and a second MerchantRegistry) contains `topOrigin`,
`clientData` or `webauthn`, so none binds a payment to a browser-signed origin. The token collectors and other
contracts they call: not checked.

What Sitebound adds is the combination: an on-chain registry from the browser-signed origin to the payout wallet,
checked at payment time by the same contract that moves the funds, and an addressless payee (`pay()` has no payee
field). It is the first we found to do this.

## AI use

Claude Code wrote much of the code, tests, pages and these docs under the author's direction. The author made the
design calls and reviewed the changes, and signs every transaction; the AI never held a key. Claims in this repo
that were not measured are marked "not checked".

## License

MIT, see `LICENSE`.
