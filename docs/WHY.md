# Why we are building Sitebound

## The problem

On a crypto checkout today, the website's payout address sits in its own page code. Whoever changes that code
changes who gets paid. One compromised dependency can rewrite the address on the page, in the clipboard, or in the
transaction the wallet is asked to sign, and the buyer is left comparing 40 hex characters. Card buyers get
3-D Secure, a bank step that shows the merchant and the amount. Crypto buyers sign raw transactions.

## The web code in front of a wallet gets attacked

Each figure is as the linked source states it.

| When | What was tampered | Loss, per the source |
|---|---|---|
| 21 Feb 2025 | **Bybit / Safe{Wallet}.** Malicious JavaScript served on Safe{Wallet}'s web app showed Bybit's signers a normal transaction while they signed one that handed over the cold wallet. | $1.5 billion ([cside](https://cside.com/blog/bybit-attack-1-5b-stolen-through-malicious-javascript)) |
| 2 Dec 2021 | **BadgerDAO.** A script injected into the app.badger.com front end through Cloudflare Workers, with a rogue API key, made users' wallets approve tokens to the attacker. | "$120 million" ([Rekt](https://rekt.news/badger-rekt/)). More than $130 million, about $9 million possibly recoverable ([ForkLog](https://forklog.com/en/badgerdao-team-reveals-details-of-121-million-hack/), quoting Badger's post-mortem) |
| 29 Oct 2026 | **Polymarket, DebugBear script.** A page-speed script polymarket.com loaded from DebugBear was swapped for code that used signed-in sessions to sell positions and move funds out. DebugBear says its DNS records were changed through its registrar. | About $2.64 million reached the attacker in under an hour ([The Hacker News](https://thehackernews.com/2026/11/hackers-steal-about-27-million-from.html), from on-chain data). About $2.7 million refunded to 726 wallets ([The Record](https://therecord.media/polymarket-returning-funds-to-customers-after-site-compromise)) |
| Jun 2026 (confirmed 25 Jun) | **Polymarket, vendor script.** A separate, earlier incident: a compromised third-party vendor injected a script that asked users to sign approvals moving pUSD to the attacker. | "Roughly $3 million", per Polymarket ([cside](https://cside.com/blog/polymarket-client-side-supply-chain-attack), [The Defiant](https://thedefiant.io/polymarket-confirms-3-million-loss-third-party-front-end-supply-chain-breach)) |
| Dec 2023 | **Ledger Connect Kit.** The `@ledgerhq/connect-kit` library (v1.1.5 to 1.1.7), also served from a CDN, was replaced with a drainer after a former employee's npm account was phished. | More than $610,000, per ZachXBT. "On the order of $850,000", per Revoke.cash (both in [The Register](https://www.theregister.com/2023/12/16/ledger_crypto_conect_kit/)) |
| 9 Aug 2022 | **Curve Finance.** A DNS hijack served a cloned curve.fi with injected JavaScript that asked users to approve a malicious contract. | "Approximately $575k" ([Rekt](https://rekt.news/curve-finance-rekt/)). "About $570K" ([Curve](https://curve.substack.com/p/august-10-2022-curve-frontend-hacked)) |
| 17 Aug 2022 | **Celer cBridge.** A BGP hijack of the server that told the cBridge site which contracts to use showed some visitors attacker contracts and asked for unlimited approvals. | "Approximately $235,000" ([Kentik](https://www.kentik.com/blog/bgp-hijacks-targeting-cryptocurrency-services/)). "$240k" ([Revoke.cash](https://revoke.cash/exploits/celer)) |
| 8 Sep 2025 | **npm chalk, debug and 18 more packages.** Phished maintainer credentials let attackers publish browser code that hooks `fetch`, XHR and `window.ethereum` and rewrites crypto destination addresses to lookalike attacker addresses. | About $600, per Socket, in packages with 2 billion weekly downloads ([The Hacker News](https://thehackernews.com/2025/09/20-popular-npm-packages-with-2-billion.html)) |

What these show, and what they do not:

- **We found no documented merchant-checkout address swap with a verified loss figure.** The closest mechanism is
  the npm compromise above: code in the browser rewriting where crypto goes. Its loss was small; its reach was not.
- **Sitebound would not have stopped most of these.** They are tampered apps that got users to sign approvals or
  transactions. Sitebound does not control what else a page asks a wallet to sign. They show that the scripts, the
  dependencies and the DNS in front of a wallet are a target. Sitebound fixes one piece: who a checkout payment pays.

## What Sitebound changes

- **No address in the checkout.** The shop pastes `<sitebound-pay amount="12.00" order="A123">`. `pay()` has no payee
  field: the contract pays the wallet registered for the site the browser signed (`topOrigin`). Hacked page code
  can change the page, not who gets paid. How: [ARCHITECTURE.md](ARCHITECTURE.md).
- **A 3-D Secure-style step.** The frame shows the site and the amount, and one Touch ID signs exactly that payment.
  It is a confirmation step, not hack-proof and not phishing protection: a lookalike domain with its own wallet still
  gets paid by a buyer it fools ([THREAT-MODEL.md](THREAT-MODEL.md)).
- **No gas for buyers.** A relayer pays the gas and the buyer pays a 0.01 USDT fee.
- **Easy for a web2 business to start.** A domain, a wallet created in the browser, and one DNS TXT record.

## Why the name

A soulbound token stays with one wallet. A Sitebound payment stays with one site: the passkey signs the site the
browser reports, and the contract pays only the wallet registered for that site. The name is an analogy; Sitebound
mints no token.
