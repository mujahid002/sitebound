# Deployments and verification

Live addresses on Whitechain Sepolia (chain 1874) and three independent ways to check that the deployed code is this repo. Back to the [README](../README.md).

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
  that uses the `<sitebound-pay>` button (`web/portfolio/index.html`). Registered on V2 at block 12,416,278
  (06:20 IST, 7 Nov), tx `0x964220005b082172d8b06777eb0535ae4a5204633bd1ad8bd39830426279002c`, payout
  `0x0eCFCF7d2b8c76794Af34b061a9886786fE6709f` (`splitOf`, measured 07:25 IST, 7 Nov).
- Relayer Worker: https://sitebound-relayer.sitebound-relayer.workers.dev (`/health`)
- First real USDT payment (Whitechain Sepolia testnet transaction; testnet USDT has no real value): 3 USDT to
  0xmujahid.xyz (order `COFFEE-…`), block 12,419,948, status success, tx [`0x65a00ae0…71d0`](https://explorer.testnet.whitechain.io/tx/0x65a00ae0fec55014c6331f2767e815ea8c49e00241b6215d7a917e3076cd71d0).
  - Buyer `0xEF37153803f75630c64475c17EC0547e65Ba3B6d`, contract SiteboundV2. The relayer sent it, so the buyer paid
    no gas. The transaction logs show 3 USDT to the payout wallet `0x0eCF…709f` and 0.01 USDT to the relayer.
  - [Receipt](https://sitebound-pay.pages.dev/receipt/?id=0x6f35db4f550b0e40d646bd02a633964e94c4f5a6e6d07c2537cfe67d14fab9d6)
    and [dashboard](https://sitebound-pay.pages.dev/dashboard/?site=0xmujahid.xyz).
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
