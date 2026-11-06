# Sitebound threat model

This covers SiteboundV2 (`src/SiteboundV2.sol`) as of commit 1051525, the frame (`web/frame/`) and the relayer
(`worker/src/index.js`). Line numbers refer to those files. The live deployment on Whitechain Sepolia is still v1
(`src/Sitebound.sol`, `0x43bb27f7079c76D6F0Fa4b4e6d69843e0457DF73`) until V2 is deployed at
`0x64117398C837a8708a816818b31C36Df5a968596`. Testnet only. An independent AI review of V2 found no
critical or high issues and its fixes are in. There has been no professional audit.

## What it stops

Sitebound defends against **recipient substitution**: hacked or malicious JavaScript on a real website changing who
receives a payment. This includes an address swapped on the page, in the clipboard, or in the transaction.

- `pay()` has no payee argument (`SiteboundV2.sol:584`). The contract pays the split registered for the site
  (`_settle`, `:659`–`:685`).
- The site is read from `topOrigin` in `clientDataJSON` (`:639`–`:640`). The browser writes `topOrigin`, and the
  passkey signature covers it, so page code cannot change it.
- The contract also checks the following (`:632`–`:650`):
  - the signature came from the Sitebound frame: `origin`, plus `crossOrigin:true`;
  - the RP ID hash;
  - that user presence and user verification are both set;
  - a challenge that fixes the chain, the contract, the site, the site's config version, the order, the amount, the
    relayer fee and the deadline.
- Each order id pays once per site (`orderUsed`).

It is **not phishing protection**. A lookalike domain that registers its own wallet gets paid by any buyer it fools.
The frame shows the real site the buyer is on; it does not vouch for that site (see the overlay limit below).

## Trusted

| Who | What they can do | What they cannot do |
|---|---|---|
| **DNS attestors** (the active set, `threshold` of them) | Register a new site with any split. They also propose a new split for an existing site that is not owner-frozen; it takes effect after `delay` (`register`, `:274`–`:300`). They rotate the attestor set; the new set takes effect after `delay` (`proposeAttestors`, `:224`). | Pay anyone outside a site's registered split. Change a split faster than `delay`. Register a site the owner has frozen (`:294`). |
| **The relayer** (`worker/`) | Pays gas and earns the fee the buyer signed, capped on-chain at one whole token (`maxRelayerFee`, `:196`, `:614`). It can refuse or delay any request. Today it is also the only attestor. | Change the payee, the amount or the order: they are all in the passkey signature. |
| **Frame host** `sitebound-pay.pages.dev` and its code | Show the buyer anything at all. Whoever controls the frame origin can ask the passkey to sign any challenge for any amount. That stays inside the buyer's caps and pays a registered split. | Change the site the browser writes into `topOrigin`. |
| **The buyer's browser and authenticator** | Write `topOrigin`, `origin` and `crossOrigin`, and keep the passkey private. | n/a (trusted) |
| **Guardian** (constructor argument, immutable, `:200`) | Pause and unpause new payments: `pay` and `payWithQuote` (`setPaused`, `:529`; checked at `:612`). | Move funds, or stop refunds, registrations, freezes or bindings. |
| **Site owner** (`to[0]` of the current split) | Freeze and unfreeze (`:344`, `:360`). Set the refund operator, the quote signer and admins: each takes effect after `delay`, and removing an admin is immediate. Refund from its own funds. Drop a non-owner recipient at once (`dropRecipient`, `:371`). | Add a recipient or move a share to anyone but itself without the attestors and `delay`. |
| **Site admins** (up to 3, `:22`, `:432`) | Refund from their own funds. Freeze payments for 72 hours (`ADMIN_FREEZE`, `:24`, `:353`). | Unfreeze, cancel a pending split, block registration, or change the operator, the quote signer, the admins or the payout. |
| **USDT issuer** | Freeze addresses. A blocked split recipient makes payments to that site revert until the owner drops it. | n/a |

There is no contract owner, no proxy and no upgrade path (`delegatecall` and `selfdestruct`: 0 occurrences in
`src/SiteboundV2.sol`). Token, frame origin, RP ID, delay, guardian and the fee cap are fixed at deploy.

## Not trusted

- The website's JavaScript, its dependencies and its DOM.
- The page around the frame, including a page that embeds the real frame (it can only pay its own registry entry).
- The DNS of lookalike domains: they get their own registry entry, never the real site's.
- Whoever submits `pay()`: it is permissionless, and the signature fixes every field that matters.

## Trade-offs we chose

- **1-of-1 attestor is one trusted authority, not decentralized.** The deploy plan is `THRESHOLD=1` with the relayer
  as the only attestor. With k = 1, rotation adds no safety: the one key can rotate the set to itself or to any key.
  A k-of-n set (tested at 2-of-3) only helps once the keys are held by different parties.
- **The attestor's DNS check is off-chain.** The relayer reads `_sitebound.<host>` TXT over Cloudflare DNS-over-HTTPS
  without DNSSEC (`worker/src/index.js:55`–`:71`). Anyone who takes over a site's DNS, or the attestor key, can get a
  new split attested. For an existing site it waits `delay` (3600 s planned; the constructor allows 1 s to 30 days,
  `:192`), and the owner can freeze it in that window.
- **No DNS TXT format for splits yet.** The relayer always attests one wallet: `to = [payout]`, `bps = [10000]`
  (`worker/src/index.js:164`–`:171`). Splits need a separately signed attestation.
- **Demo sites bypass DNS.** `DEMO_SITES` in `worker/wrangler.toml` pins a payout for pages.dev hosts whose DNS we
  don't control. A pinned site can only register its pinned payout (`worker/src/index.js:139`–`:147`).
- **A stolen owner key can freeze a site permanently.** An owner freeze drops the pending split and blocks
  registration. Only the owner can lift it, so no attestation can recover the site.
- **An admin freeze cannot cancel a recovery, but it can delay payments.** If the owner key is lost, the attestors
  can register a recovery split. An admin's freeze only stops payments for 72 hours and leaves that pending split
  alone. When the split makes someone else the owner, every admin, the refund operator, the quote signer and any
  admin freeze are cleared (`_promote`, `:495`–`:507`). Until then, a hostile admin can re-freeze every 72 hours; the
  owner can remove it at once.
- **The owner can cut a partner's share at once.** `dropRecipient` exists so that a recipient the token refuses to
  pay does not block the site. Its share goes to the owner immediately, not after the attestors and `delay`.
  Partners who need protection from the owner should not rely on a Sitebound split alone.
- **Refunds are merchant-funded.** The refunder pays from its own allowance to the original payer only. The total is
  capped at the payment's amount; the relayer fee is not refundable (`refund`, `:694`–`:709`).
- **The guardian is immutable.** It has no rotation or timeout. A stolen guardian key can keep payments paused until
  the contract is redeployed. `address(0)` means no one can pause. It adds a liveness risk only: a pause stops new
  payments and moves nothing.
- **Daily caps and the minimum fee are enforced by the relayer only, not on-chain.** The defaults are 20 pays per
  passkey, 3 setups per wallet, 3 registrations per site, and a 0.01 USDT minimum fee (`worker/src/index.js:174`,
  `:193`, `:207`, `:217`). The count is a KV read then a write, not atomic. Anyone can call the contract directly
  and skip all of them; the buyer's own caps still apply.

## Known limits

- **UI redressing.** A hacked or fake page can draw over the frame and lie about the site or the amount. It cannot
  change the payee, and the buyer's caps bound the amount.
- **The amount comes from the page.** Hacked page code can ask for a different amount; the buyer sees it in the
  frame. A site that sets a **quote signer** closes this. Every payment then needs `payWithQuote` with a Quote
  (site, order, token, amount, expiry) signed by the site's backend (`:594`). A changed amount fails with "bad quote".
- **A quote does not name the payer.** Anyone with a bound passkey can use a quote they see first. It is griefing
  only: they pay the full quoted amount to the site, and the real buyer's attempt fails with "order used" (test
  `test_quote_is_not_bound_to_the_payer_and_the_taker_pays_in_full`).
- **Order squatting.** Anyone can pay a site with any unused order id, at their own cost, which burns that id for the
  real buyer. Use random order ids, and check on your server before you ship (`verifyPayment` in
  `web/merchant/sitebound-merchant.mjs`). The `sitebound:paid` event alone is not proof.
- **Browsers.** Chrome is measured: the fixture `test/fixtures/frame_assertion_v2.json` is a real Chromium 148
  assertion. Safari: one Apple forum report (Safari 18.4, May 2025) says it omits `topOrigin`. Not measured.
  Firefox: not checked. A missing `topOrigin` fails closed: "no topOrigin" (`:639`).
- **Attestations are not revocable on-chain.** An unused attestation stays valid until one of these happens:
  - its own deadline passes (the relayer signs for 1 hour, `worker/src/index.js:164`);
  - another registration for that site uses the nonce;
  - the attestor set rotates (each attestation names its set id).
- **Bind signatures are not revocable either.** An unsubmitted `bind` signature can only be cancelled by using up the
  wallet's `bindNonce`, through another `bind` or an `unbind` (`:539`, `:569`).
- **Pubkey and credential squatting.** Front-running `bind` with a victim's passkey public key or credential hash
  blocks their setup (`:553`, `:555`). It moves no funds.
- **Linkability.** Credential hashes, wallets, sites and amounts are public. A buyer's purchases can be linked across
  sites.
- **Relayer fee.** The fee goes to whoever submits the signed payment first.
- **Testnet only. No professional audit.**
