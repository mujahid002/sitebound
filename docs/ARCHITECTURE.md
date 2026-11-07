# Architecture

How the parts of Sitebound fit together, with the code that does each step. Line numbers are for the files as of
this commit. The trust model and its limits are in [THREAT-MODEL.md](THREAT-MODEL.md).

## Parts

```mermaid
flowchart LR
  subgraph browser["Buyer's browser"]
    shop["Shop page on its own domain, with the sitebound-pay button"]
    frame["Checkout frame, a cross-origin iframe from sitebound-pay.pages.dev"]
    setup["Setup popup on sitebound-pay.pages.dev, first time only"]
    passkey["Passkey, WebAuthn P-256, Touch ID"]
    wallet["Buyer wallet, holds USDT, capped allowance to SiteboundV2"]
  end
  relayer["Relayer, a Cloudflare Worker. Checks DNS, signs the attestation, pays gas"]
  dns["DNS TXT record at _sitebound.HOST"]
  subgraph chain["Whitechain Sepolia, chain 1874"]
    sb["SiteboundV2 contract"]
    registry["Registry, site to payout wallet"]
    p256["P-256 precompile at 0x100, RIP-7212"]
    usdt["USDT with EIP-2612 permit"]
    payout["Site's payout wallet"]
  end
  shop -- "button opens" --> frame
  frame -- "first payment opens" --> setup
  setup -- "creates" --> passkey
  setup -- "asks to sign permit and bind" --> wallet
  frame -- "asks to sign one payment" --> passkey
  frame -- "signed payment" --> relayer
  setup -- "signed permit and bind" --> relayer
  relayer -- "reads" --> dns
  relayer -- "sends register, permit, bind, pay" --> sb
  sb -- "looks up the signed site" --> registry
  sb -- "verifies the passkey signature" --> p256
  sb -- "transferFrom buyer" --> usdt
  usdt -- "amount" --> payout
```

| Part | Code | Job |
|---|---|---|
| Button | `web/button/sitebound.js` | The `<sitebound-pay amount order>` element. Opens the frame in a modal `<dialog>` (`:51`–`:63`) and re-fires `sitebound:paid` (`:69`–`:71`). It holds no address. |
| Frame | `web/frame/frame.js`, `lib.js` | Reads the site from `location.ancestorOrigins` (`:15`–`:18`), shows site and amount, asks the passkey to sign, sends the result to the relayer. |
| Setup popup | `web/frame/setup.js` | First time only: wallet, caps, passkey, permit and bind signatures. |
| Onboarding | `web/onboard/app.js` | A shop's wallet, DNS record, registration and snippet. |
| Contract | `src/SiteboundV2.sol` | Registry, attestors, passkey bindings with caps, `pay()`, refunds. No owner, no upgrade path. |
| Relayer | `worker/src/index.js` | `/dns/check`, `/register`, `/setup`, `/pay`, `/health`. The only attestor (1-of-1) and the gas payer. |
| Merchant helper | `web/merchant/sitebound-merchant.mjs` | `verifyPayment` and `signQuote` for the shop's server. |

## Onboarding a shop

```mermaid
sequenceDiagram
  autonumber
  actor owner as Shop owner
  participant wiz as Onboarding page
  participant dnsp as Shop's DNS provider
  participant relayer as Relayer
  participant doh as Cloudflare DNS over HTTPS
  participant sb as SiteboundV2
  owner->>wiz: Types the domain, for example https://shop.example
  wiz->>wiz: Creates a payout wallet in the browser, or connects MetaMask or Rabby
  wiz-->>owner: Shows TXT name _sitebound.HOST and value sitebound=PAYOUT
  owner->>dnsp: Adds the TXT record
  loop Every 5 s, up to 36 tries
    wiz->>relayer: POST /dns/check with the site
    relayer->>doh: TXT query for _sitebound.HOST
    doh-->>relayer: sitebound=PAYOUT
    relayer-->>wiz: Payout found
  end
  owner->>wiz: Register site
  wiz->>relayer: POST /register with site and payout
  relayer->>doh: Reads the record again, it must name the same payout
  relayer->>relayer: Signs an EIP-712 Attest for one wallet at 10000 bps, valid 1 hour
  relayer->>sb: register with the site, the split and the signature
  sb->>sb: Checks the quorum signature, stores site to payout
  sb-->>relayer: Registered event
  relayer-->>wiz: Transaction hash
  wiz-->>owner: Snippet to paste, with no address in it
```

- The wallet is `ethers.Wallet.createRandom()`, kept in that browser's `localStorage` with an optional backup
  (`web/onboard/lib.js:203`, `:216`–`:224`). The owner signs nothing and pays no gas to register.
- The relayer reads `_sitebound.<host>` over Cloudflare DNS-over-HTTPS, without DNSSEC (`worker/src/index.js:65`–`:83`).
  Two lists skip DNS: `DEMO_SITES` and sites added through the admin API (`:160`–`:165`).
- A new site is live at once. A new payout for a site that is already registered waits `delay` (1 hour on the
  deployment), and the current owner can freeze it in that window (`src/SiteboundV2.sol:288`–`:299`).

## A buyer's first-time setup

```mermaid
sequenceDiagram
  autonumber
  actor buyer as Buyer
  participant frame as Checkout frame
  participant setup as Setup popup
  participant wallet as Buyer wallet
  participant auth as Passkey authenticator
  participant relayer as Relayer
  participant usdt as USDT
  participant sb as SiteboundV2
  buyer->>frame: Confirm payment, no passkey set up yet
  frame->>setup: Opens setup.html as a popup on the frame origin
  setup->>wallet: Connect, switch to chain 1874
  buyer->>setup: Per-payment limit, total limit, expiry in days
  setup->>auth: navigator.credentials.create, P-256, user verification required
  auth-->>setup: Public key x and y, credential id
  setup->>wallet: Sign EIP-2612 permit for SiteboundV2, value = total limit
  setup->>wallet: Sign EIP-712 Bind with the passkey key, limits, expiry, nonce
  setup->>relayer: POST /setup with both signatures
  relayer->>usdt: permit
  relayer->>sb: bind
  sb->>sb: Checks the wallet signed the Bind, one wallet per passkey
  sb-->>relayer: Bound event
  setup->>sb: Reads buyers of the credential, it must be this wallet
  setup-->>frame: setup-done message
```

- The passkey comes first because the Bind signature includes its public key (`web/frame/setup.js:99`–`:113`).
- The relayer refuses limits below its fee, simulates both calls, then sends `permit` and `bind`
  (`worker/src/index.js:201`–`:227`). If the relayer fails, "Submit from my wallet instead" sends both from the buyer's wallet,
  which then pays the gas (`setup.js:152`–`:173`).
- After setup, a payment needs no wallet popup. The caps live in the contract (`src/SiteboundV2.sol:621`–`:627`).

## A payment

```mermaid
sequenceDiagram
  autonumber
  actor buyer as Buyer
  participant shop as Shop page
  participant frame as Checkout frame
  participant auth as Passkey authenticator
  participant relayer as Relayer
  participant sb as SiteboundV2
  participant usdt as USDT
  participant server as Shop server
  buyer->>shop: Pay 12.00 USDT
  shop->>frame: iframe with amount and order, plus quote if the site uses one
  frame->>sb: Reads configVersion and the site's registry entry
  frame-->>buyer: Shows the site from ancestorOrigins and the amount
  buyer->>frame: Confirm payment
  frame->>frame: challenge = keccak256 of chain id, contract, site, config version, order, amount, fee, deadline
  frame->>auth: navigator.credentials.get with that challenge
  auth-->>frame: Signature over clientDataJSON, which the browser fills with origin, crossOrigin and topOrigin
  frame->>relayer: POST /pay with the signed input, fee 0.01 USDT
  relayer->>sb: pay, or payWithQuote
  sb->>sb: P-256 check at 0x100, origin is the frame, crossOrigin is true
  sb->>sb: Site = topOrigin, challenge matches, order unused, caps and expiry
  sb->>usdt: transferFrom buyer to the registered payout wallet
  sb->>usdt: transferFrom buyer to the sender, the 0.01 USDT fee
  sb-->>frame: Paid event in the receipt
  frame-->>shop: sitebound:paid with order, tx hash, payment id
  shop->>server: Order paid?
  server->>sb: verifyPayment reads payments of the payment id
  sb-->>server: Payer, site, amount, refunded
```

- The challenge is built in the frame (`web/frame/lib.js:56`–`:62`) and rebuilt in the contract
  (`src/SiteboundV2.sol:645`–`:650`). It names the chain and the contract, so a signature cannot be replayed
  elsewhere, and the site's config version, so it cannot execute after a payout or settings change. The deadline is
  10 minutes (`frame.js:89`).
- The contract reads the site from `topOrigin` (`:639`–`:640`) and pays the split registered for it (`_settle`,
  `:659`–`:686`). `pay()` has no payee field.
- The fee goes to `msg.sender` (`:681`), whoever submits. It is capped on chain at 1 USDT (`maxRelayerFee`), and the
  relayer asks for at least 0.01 USDT (`MIN_FEE` in `worker/wrangler.toml`).
- "Use a crypto wallet instead" skips the relayer: fee 0, and the buyer's wallet sends `pay()` and pays the gas in WBT
  (`frame.js:124`–`:128`, `web/frame/wallet.js:39`–`:44`).
- The frame trusts the chain, not the relayer: it waits for a `Paid` log for this payment id (`frame.js:155`–`:162`).
  The shop's server should do the same with `verifyPayment` (`web/merchant/sitebound-merchant.mjs:52`–`:63`), because
  any script on the page can fire `sitebound:paid`.

## What an attacker can and cannot do

```mermaid
flowchart TD
  a1["Hacked script on the real shop page swaps an address"] --> r1["Stopped. There is no address to swap. The payee comes from the registry entry for topOrigin"]
  a2["Fake site embeds the real frame to pass as the real shop"] --> r2["Stopped. topOrigin is the fake site, so it can only pay its own registry entry, or fail if it has none"]
  a3["Hacked page changes the amount, site uses quotes"] --> r3["Stopped. The contract rejects it with bad quote"]
  a4["Hacked page changes the amount, no quotes"] --> r4["Not stopped. The buyer sees the new amount in the frame and must confirm it. Caps apply. Payee unchanged"]
  a5["Page draws an overlay over the frame"] --> r5["Not stopped. It can cover the site line. The payee still follows topOrigin"]
  a6["Lookalike domain registers its own wallet"] --> r6["Not stopped. It is a real site in the registry, and a fooled buyer pays it"]
  classDef stop fill:#d8f3e6,stroke:#0b7a5a,color:#0d0f11
  classDef open fill:#fde2e0,stroke:#b42318,color:#0d0f11
  class r1,r2,r3 stop
  class r4,r5,r6 open
```

- Sitebound fixes **who gets paid**, not whether the buyer is on the right site. It is a 3-D Secure-style
  confirmation, not phishing protection and not hack-proof.
- Trusted: the attestor's DNS check (today one key, the relayer's), the frame host's code, the buyer's browser, and
  the USDT issuer. Details and line references: [THREAT-MODEL.md](THREAT-MODEL.md).
- The demos: [address swap](https://sitebound-demo.pages.dev/attack/), and a
  [fake site with the overlay](https://sitebound-phish.pages.dev).
