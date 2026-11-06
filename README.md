# Sitebound

Addressless stablecoin checkout: every payment is bound to the site the buyer is actually on.

Built for ETHGlobal Mumbai (Nov 2026) on Whitechain Sepolia testnet. Not audited.

## The problems

1. **Hacked checkout code swaps addresses.** The shop's address lives in its checkout JavaScript. One
   compromised dependency rewrites it (on the page or in the clipboard) and the money goes to the attacker.
   The npm "qix" package compromise in Sep 2025 rewrote crypto recipients this way.
2. **Addresses are bad checkout UX.** Shops paste and manage an address per chain. Buyers copy, paste or scan
   one and have to compare 40 hex characters they can't read.
3. **Crypto has no 3-D Secure.** Card buyers get a confirmation step from their bank that shows the merchant and
   the amount. Crypto buyers sign raw transactions.

## How it works

- **Shop, once.** It proves it controls its domain with a DNS TXT record (`_sitebound.<host>` =
  `sitebound=<payout>`). An attestor checks the record and signs; anyone submits `register()`. The registry now maps
  `keccak256("https://shop.com")` to the shop's payout wallet. The shop pastes one script tag and a
  `<sitebound-pay amount="12.00" order="A123">` element. There is no address in its code.
- **Buyer, first time.** In a popup on the Sitebound origin: connect a wallet, sign a capped EIP-2612 permit and an
  EIP-712 binding (passkey public key, per-payment cap, total cap, expiry), and create a passkey. One passkey is bound
  to one wallet.
- **Buyer, every payment.** The button opens the Sitebound frame in a cross-origin iframe. The frame shows the site
  (from `location.ancestorOrigins`) and the amount, and calls WebAuthn `get()`. One Touch ID signs one exact
  payment: site, order id, amount, relayer fee, deadline.
- **Contract.** Chrome writes the embedding page's origin into the signed `clientDataJSON` as `topOrigin`. Page
  code can't change it. `pay()` checks the passkey signature with the P-256 precompile at `0x100`, checks that the
  signature came from the Sitebound frame (`origin`, `crossOrigin:true`), and moves USDT from the buyer's wallet to
  `registry[keccak256(topOrigin)]`. There is no payee field in the call.

Hacked checkout code can change what the page shows. It can't change who gets paid.

**Why on-chain settlement:** the site check runs in the same contract that moves the money, so hacked checkout code
can't redirect it. An off-chain processor can't give the buyer that guarantee.

## Architecture

| Part | Path | What it does |
|---|---|---|
| Contract | `src/Sitebound.sol` | Site registry, passkey bindings with caps, `pay()`, refunds. No owner. |
| Frame | `web/frame/` | Checkout iframe (`get()` only) and the first-time setup popup. Vanilla JS + vendored ethers 6.17.0. |
| Button | `web/button/sitebound.js` | The `<sitebound-pay>` element. Opens the frame from its own host; fires `sitebound:paid`. |
| Relayer (optional) | `worker/` | Cloudflare Worker. Pays gas for `register`, `permit`, `bind`, `pay`. Also the DNS attestor. See `worker/README.md`. |
| Onboarding | `web/onboard/` | Shop setup: wallet, DNS TXT check, register, snippet. |
| Dashboard | `web/dashboard/` | Payments to one site from chain events, refunds, CSV. |
| Landing | `web/landing/` | Public page. |
| Demo shop | `web/demo-shop/` | A store whose checkout is only the `<sitebound-pay>` element. |
| Attack demos | `web/attack/` | Address swap on a classic checkout, the same script against Sitebound, a fake site embedding the frame. |

The relayer only pays gas. `pay()` is permissionless and the payee comes from the registry, so a relayer can refuse
a payment but can't redirect one. The frame also offers "Pay from my wallet": the buyer submits `pay()` with
`relayerFee = 0` and pays gas in WBT.

## Setup and local dev

Requires Foundry, Python 3 and Chrome (the only browser measured so far).

```sh
forge install foundry-rs/forge-std   # lib/ is not committed
forge test
```

`forge test` has no P-256 precompile, so the tests etch a Solidity verifier (`test/utils/P256Verifier.sol`) at
`0x100`. One test replays a real Chrome assertion from a cross-origin iframe (`test/fixtures/frame_assertion.json`).

Web, locally (shop and frame must be different origins):

```sh
python3 web/dev/serve.py
# shop  http://127.0.0.1:8001   (web/ served with no-store)
# frame http://localhost:8002   (the same web/ folder, a different origin)
```

- Demo shop: http://127.0.0.1:8001/demo-shop/
- Attack demos: http://127.0.0.1:8001/attack/. For the fake-site page, serve `web/` on a third origin too:
  `python3 -m http.server 8003 --bind 127.0.0.1 --directory web`, then open http://127.0.0.1:8003/attack/phish.html.
- Local passkeys use rpId `localhost`, so the frame must be on `localhost`.
- `web/config.js` holds the chain id, RPC, explorer, contract address and relayer URL for the frame.

Paying on the local shop needs `http://127.0.0.1:8001` registered on the deployed contract. The relayer only attests
`https://` origins, so that registration needs a separately signed attestation: not checked.

### Demo site

The demo shop is static and can be its own Cloudflare Pages project. A real shop loads the button from the
Sitebound frame host, because the button opens the frame next to its own script URL. Before deploying, point the
`<script src>` in `web/demo-shop/index.html` (and in `web/attack/sitebound.html`, `web/attack/phish.html`) at the
deployed frame host, then:

```sh
mkdir -p dist && cp -r web/demo-shop web/attack dist/
npx wrangler pages deploy dist --project-name <name>
```

Not checked yet. The shop's Pages origin (e.g. `https://<name>.pages.dev`) has to be registered like any other site.

### Deploy the contract

```sh
FRAME_ORIGIN=https://<frame host> RP_ID=<frame host> ATTESTOR=<attestor address> DELAY=3600 \
  forge script script/Deploy.s.sol --rpc-url $RPC_URL --account <keystore> --broadcast
```

Token: Whitechain Sepolia USDT `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` (6 decimals). `DELAY` defaults to 1 hour.

## Deployments (Whitechain Sepolia, chain 1874)

- Sitebound contract: [`0x43bb27f7079c76D6F0Fa4b4e6d69843e0457DF73`](https://explorer.testnet.whitechain.io/address/0x43bb27f7079c76D6F0Fa4b4e6d69843e0457DF73)
  (token: Whitechain USDT, `DELAY` 1 hour, frame origin `https://sitebound-pay.pages.dev`)
- Verified source: Sourcify exact match. Blockscout: failing on the explorer's side, see "Verify it yourself" below.
- Frame, landing, onboarding, dashboard: https://sitebound-pay.pages.dev
- Demo shop: https://sitebound-demo.pages.dev
- Relayer Worker: https://sitebound-relayer.sitebound-relayer.workers.dev (`/health`)
- First USDT payment: TBD
- Explorer: https://explorer.testnet.whitechain.io

## Verify it yourself

Three independent ways to check that the contract above is the code in this repo (the commit is in
`web/verify/expected.json`; solc 0.8.28, via-IR, optimizer 200 runs, EVM cancun):

- **Sourcify: exact match** for both the creation and the runtime code:
  https://repo.sourcify.dev/1874/0x43bb27f7079c76D6F0Fa4b4e6d69843e0457DF73
- **From source, on your machine:** `sh scripts/verify.sh`. It rebuilds with `forge`, reads the deployed code with
  `cast`, zeroes the immutables (token, rpIdHash, delay) in both, and compares. It prints
  `MATCH 0xaa7fc4f738a41cc4ff55b7dfc84353a4ee48244e2074ddbdeecab73c19633f1f` (measured 6 Nov). Needs only
  Foundry; the public RPC is the default.
- **In your browser:** "Verify us" on https://sitebound-pay.pages.dev/landing/#verify reads the code with
  `eth_getCode`, applies the same masking, and compares the hash with `web/verify/expected.json`. It also checks that
  the token, RP ID hash and delay baked into the code are the values that file lists.

Blockscout verification is currently failing on Whitechain's side. Our submissions end in "Fail - Unable to
verify", although the local build output equals the deployed creation bytecode byte for byte. The explorer
verified 40 contracts between 12:09 and 15:03 IST on 6 Nov and none after that, and its verification config lists
no compiler versions (both checked 17:10 IST). Details in WHITECHAIN_FEEDBACK.md. Standard-JSON input:
`forge verify-contract --show-standard-json-input`.

## Threat model and limits

What it stops: hacked checkout JavaScript on the real shop redirecting a payment. The payee is
`registry[topOrigin]`, and `topOrigin` is written by the browser into the signed data. A fake site embedding the
frame can only pay its own registry entry. Editing the signed origin, or signing from a lookalike frame on another
origin, fails the contract's checks. Each signature is for one order id, one amount and one deadline.

Known limits:

- **UI redressing.** A hacked or fake page can draw over the frame and lie about the site or amount shown. It can't
  change the payee, and the buyer's caps bound the amount. A fake site that registered its own domain does get paid
  by a buyer it fooled: Sitebound shows the real site, it does not vouch for what a shop sells.
- **Amount.** Hacked page code chooses the amount it asks for. The buyer sees it in the frame and confirms it.
- **Safari** may omit `topOrigin` (one forum report; not measured). Firefox: not checked.
- **DNS.** Someone who takes over the shop's DNS can get a new payout attested. Changing an existing site's payout
  waits `DELAY`, and the current payout can `freeze()` the site in that window.
- **The attestor's DNS check is trusted.** It reads TXT over Cloudflare DNS-over-HTTPS, without DNSSEC.
- **Our frame's code is trusted.** Whoever serves the frame origin can make it show anything.
- **Linkability.** Credential hashes are on-chain, so a buyer's purchases can be linked across shops.
- **Pubkey squatting.** An attacker can front-run `bind` and bind a victim's passkey public key to the attacker's
  own wallet first. That blocks the victim's setup (nuisance), it doesn't move funds.
- **Order squatting.** Anyone can bind their own key to their own wallet and pay a shop with any order id, which
  burns that id for the real buyer. Zero amounts are rejected, so it costs the squatter real tokens, but a shop
  must still check on-chain before fulfilling: `payments(paymentId).amount` equals the price, and order ids should
  be random, not guessable. The `sitebound:paid` event alone is not proof of payment.
- **Freeze.** A stolen payout key can freeze a site for good, and no attestation can rotate the payout while it is
  frozen. After a pending change goes live (`DELAY`), the old payout can no longer freeze.
- **Relayer fee** goes to whoever submits the payment first. `credentialHash` can be squatted by front-running `bind`.
- **Issuer risk.** USDT's issuer can freeze addresses.
- Testnet only. Not audited.

## CROPS notes

- **No owner, admin, pause or upgrade.** Token, frame origin, rpId, attestor set and delay are set in the
  constructor and never change.
- **Permissionless `pay()`.** Anyone can relay and earn the signed fee, or the buyer submits it from their own
  wallet with no fee.
- **One trusted role, bounded.** The DNS attestor set is fixed at deploy. A new site registers immediately; changing
  an existing site's payout always waits `DELAY`, and the current payout can freeze it. Roadmap: an on-chain DNSSEC
  proof instead of the attestor.
- **Walkaway.** The contract never holds funds; each payment moves wallet to payout in one transaction. If we
  disappear, buyers revoke with `unbind()` or `approve(0)`, and shops keep what they were paid.
- **Self-hostable.** The frame origin is a constructor argument: anyone can host their own frame and deploy their
  own instance. The RPC is configurable. No analytics.
- **Privacy: No.** Wallet, credential hash, site and amount of every payment are public.
- **License:** MIT.

## Prior art and what is new

- [Secure Payment Confirmation](https://www.w3.org/TR/secure-payment-confirmation/) (W3C, Chrome): a WebAuthn
  assertion for payments whose signed data includes `topOrigin`, the payee's origin and the amount. The bank, as the
  relying party, verifies it off-chain. Sitebound uses the same idea, a browser-signed top-level origin, but checks it
  in the contract that moves the money.
- [RIP-7212](https://github.com/ethereum/RIPs/blob/master/RIPS/rip-7212.md): the P-256 precompile at `0x100`. It is
  what lets the contract verify every passkey signature on-chain. Whitechain Sepolia has it (see
  WHITECHAIN_FEEDBACK.md).
- [anandh8x/payeelock](https://github.com/anandh8x/payeelock): Confirmation of Payee for invoices, with a DNS-TXT
  verifier, a domain attestor and an on-chain payee registry. It has no passkeys and no binding to the browser's
  origin.
- On-chain WebAuthn verifiers (Solady, base/webauthn-sol) verify the signature but not `topOrigin`.

What Sitebound adds is the combination: an on-chain registry from the browser-signed origin to the payout wallet,
checked at payment time by the same contract that moves the funds, and an addressless payee (`pay()` has no payee
field). It is the first we found to do this. On Whitechain Sepolia, none of the 40 most recently verified contracts
on the explorer (verified 6 Nov, 12:09 to 15:03 IST; checked 17:10 IST) parses WebAuthn data (`clientDataJSON`,
`authenticatorData`) or keys payouts by a web origin or domain; a few verify P-256 signatures. Older contracts: not
checked.

## AI use

Claude Code wrote much of the code, tests, pages and these docs under the author's direction. The author made the
design calls and reviewed the changes, and signs every transaction; the AI never held a key. Claims in this repo
that were not measured are marked "not checked".

## License

MIT, see `LICENSE`.
