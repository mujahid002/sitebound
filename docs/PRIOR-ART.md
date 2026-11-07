# Prior art, CROPS notes and multi-chain plan

What exists already, what Sitebound adds, how it stands on censorship resistance, open source, privacy and security, and why it is single-chain today. Back to the [README](../README.md).

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

## Multi-chain: planned, blocked for now

Sitebound settles on Whitechain. The plan for buyers on other chains: they pay from the chain that holds their
stablecoin, [Relay](https://relay.link) moves it to Whitechain, and the contract pays the site there. Later, other
chains can get their own SiteboundV2 with the same frame and button. Next to that, we plan to talk to web2 businesses
and bring them on chain with the same onboarding: their domain and one DNS record. None of this is built yet, for
these reasons:

- **No Relay route into Whitechain yet.** Relay's chain API lists no Whitechain. On 6 Nov it had 58 mainnet chains,
  and on 7 Nov (07:40 IST) 57. Its testnet API lists only Base Sepolia and Sepolia. "Pay from any chain" waits on
  that listing. Other bridges: not checked.
- **The relayer needs gas on every chain.** Our relayer pays the gas for register, setup and every payment, from one
  hot wallet on one chain (`CHAIN_ID` in `worker/wrangler.toml`). Each new chain needs its own funded wallet, a
  Worker and monitoring. On testnet our gas comes from a faucet that gives 2 WBT a day. As a team of two with a
  testnet budget, we kept to one chain (our view).
- **One trusted DNS checker.** The relayer is also the only attestor (1-of-1). Copying that key to more chains copies
  the single point of trust; we want k-of-n attestors or an on-chain DNSSEC proof first.
- **Per-chain differences.** Each chain needs the P-256 precompile at `0x100`, or a Solidity verifier at a gas cost
  we have not measured. Its stablecoin also needs its own `permit` domain: Whitechain's USDT has no `version()`
  getter, so we found its domain by matching `DOMAIN_SEPARATOR`.

What already carries over: the passkey signs the chain id and the contract address (`src/SiteboundV2.sol:647`), so a
payment signed for one chain cannot be replayed on another. The DNS record `sitebound=<payout>` names an EVM address
that works on any EVM chain.
