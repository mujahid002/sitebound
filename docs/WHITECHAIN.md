# Whitechain prize checklist

This is Sitebound's checklist for Whitechain's **Operate: Stablecoin Payments for Business** prize at ETHGlobal Mumbai 2026.
The requirements below are the ones on the [ETHGlobal prizes page](https://ethglobal.com/events/mumbai/prizes)
(read 07:56 IST, 7 Nov 2026). Times are IST. Everything here is on Whitechain Sepolia testnet; testnet USDT has no
real value, and the contract is not audited.

## Qualification requirements

- [x] **Contracts deployed on Whitechain Sepolia (chain 1874) and verified on the Whitechain explorer.**
  - SiteboundV2 at [`0x64117398C837a8708a816818b31C36Df5a968596`](https://explorer.testnet.whitechain.io/address/0x64117398C837a8708a816818b31C36Df5a968596?tab=contract).
  - The explorer API reports `is_verified: true`, name SiteboundV2, compiler v0.8.28, verified 23:00:53 IST on 6 Nov
    (read 07:56 IST, 7 Nov).
  - Sourcify: `exact_match` for creation and runtime code ([repo.sourcify.dev](https://repo.sourcify.dev/1874/0x64117398C837a8708a816818b31C36Df5a968596)).
  - To check it yourself: `sh scripts/verify.sh` (README, "Verify it yourself"; details in [DEPLOYMENTS.md](DEPLOYMENTS.md)).
- [x] **At least one USDT payment settled on Whitechain in the main flow, with the explorer link in the README.**
  - 3 USDT to 0xmujahid.xyz through `pay()`, block 12,419,948, status success: [transaction](https://explorer.testnet.whitechain.io/tx/0x65a00ae0fec55014c6331f2767e815ea8c49e00241b6215d7a917e3076cd71d0).
  - The token is Whitechain USDT `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`, the one the contract is built with,
    not a token we minted.
  - The relayer sent it, so the buyer paid no gas. [Receipt](https://sitebound-pay.pages.dev/receipt/?id=0x6f35db4f550b0e40d646bd02a633964e94c4f5a6e6d07c2537cfe67d14fab9d6),
    [dashboard](https://sitebound-pay.pages.dev/dashboard/?site=0xmujahid.xyz).
- [x] **A README line on why this flow needs on-chain stablecoin settlement.** The README's "Why on-chain
  settlement": the registry binds each site to a payout wallet and `pay()` takes no payee argument, so no server or
  page can redirect the money. The site check runs in the same contract that moves the money, which an off-chain
  processor can't give the buyer.
- [x] **A public GitHub repo with steady progress, and a README on setup, architecture and limits.**
  - [github.com/mujahid002/sitebound](https://github.com/mujahid002/sitebound) opens without signing in (07:56 IST, 7 Nov).
  - First commit 09:56 IST, 6 Nov. 196 commits by 07:59 IST, 7 Nov: 108 on 6 Nov and 88 on 7 Nov.
  - README sections "Run it", "Repo map", "How it works" and "Threat model (summary)", plus
    [DEVELOPMENT.md](DEVELOPMENT.md) for setup, [ARCHITECTURE.md](ARCHITECTURE.md) and [THREAT-MODEL.md](THREAT-MODEL.md).
- [ ] **A 2 to 4 minute demo video showing each party.** Status: to be recorded. The script, with the shop, the buyer
  and the attacker on screen: [demo-script.md](demo-script.md).
  - TODO: video link.
- [x] **WHITECHAIN_FEEDBACK.md.** [WHITECHAIN_FEEDBACK.md](../WHITECHAIN_FEEDBACK.md): what worked, where we got stuck
  (permit domain, explorer verification, local P-256 tests, test USDT, the `eth_getLogs` range) and what kept us on
  one chain.

## What the prize asks to see

- **A drop-in piece a separate app adds in about 20 lines.** The onboarding snippet is 11 lines: one script tag, the
  `<sitebound-pay>` element and a `sitebound:paid` listener (`web/onboard/app.js:34`–`:44`). The
  [demo shop](https://sitebound-demo.pages.dev) and the [real site](https://0xmujahid.xyz) use it.
- **Both views.** Buyer: the checkout frame and the one-time setup. Merchant: onboarding and the
  [dashboard](https://sitebound-pay.pages.dev/dashboard/?site=0xmujahid.xyz).
- **Past the first payment.** Merchant-funded refunds to the original payer, a CSV export on the dashboard, and an
  on-chain receipt page.

## Whitechain features we use

- **P-256 precompile at `0x100` (RIP-7212).** The contract verifies every passkey signature on chain
  (`_p256`, `src/SiteboundV2.sol:775`–`:778`, called at `:656`). The one real `pay()` used 305,060 gas (one sample).
- **USDT `permit` (EIP-2612).** The buyer signs a capped allowance once and the relayer submits it
  (`web/frame/setup.js:103`–`:107`, `worker/src/index.js:213`–`:223`). The domain is "Tether USD", version "1"
  (`web/frame/lib.js:41`); USDT has no `version()` getter, so we found it by matching `DOMAIN_SEPARATOR`.
- **Gas paid by the relayer.** The relayer pays the WBT for `register`, `permit`, `bind` and `pay`. The buyer pays a
  0.01 USDT fee, capped on chain at 1 USDT. "Use a crypto wallet instead" pays with no fee and the buyer's own WBT.
- **Explorer verification and Sourcify.** Exact match on Sourcify, and verified source on the explorer. The explorer
  API reports `is_verified_via_sourcify: false` (07:56 IST, 7 Nov), so the explorer's verification is its own, not an
  import from Sourcify.
- **Public RPC with no key** (`https://rpc.testnet.whitechain.io`). The frame, the dashboard and "Verify us" read the
  chain straight from the browser.
