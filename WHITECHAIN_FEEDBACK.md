# Whitechain builder feedback

From building Sitebound on Whitechain Sepolia (chain 1874) at ETHGlobal Mumbai, 4 to 7 Nov 2026.
Only things we measured; the rest is marked "not checked".

## What was easy

- **P-256 precompile.** `0x100` on Whitechain Sepolia returns 1 for the RIP-7212 test vector (4 Nov) and for a
  Foundry `vm.signP256` signature (6 Nov, `cast call`). Sitebound verifies every passkey signature on-chain, so
  this is the feature the whole design rests on.
- **USDT has EIP-2612 `permit`, and it works on chain.** Buyers grant the allowance with a signature and a relayer
  pays the gas. The ERC-3009 typehashes are present too. Measured 07:48 IST, 7 Nov:
  - Our buyer wallet `0xEF371538…3B6d` has USDT `nonces` = 2, so two signed permits were executed on Whitechain.
  - Its allowance to SiteboundV2 is 196.99 USDT: the 200 USDT limit minus the 3.01 USDT paid below.
- **Public RPC.** `https://rpc.testnet.whitechain.io` works with `cast` and `curl` without a key. Every on-chain read
  in this file on 7 Nov used it.
- **Fast blocks.** Blocks 12,420,544 to 12,421,544 took 1,000 s, an average of 1.0 s per block (measured 07:48 IST,
  7 Nov).
- **A real payment settled (7 Nov).** First real USDT payment (Whitechain Sepolia testnet transaction): 3 USDT to
  0xmujahid.xyz through SiteboundV2, block 12,419,948, status success, sent by our relayer (the buyer paid no gas),
  gasUsed 305,060 at 5.001 gwei, so 0.0015 WBT of gas for one payment (one sample). Testnet USDT has no real
  value.
  https://explorer.testnet.whitechain.io/tx/0x65a00ae0fec55014c6331f2767e815ea8c49e00241b6215d7a917e3076cd71d0
  The passkey check by the `0x100` precompile (`src/SiteboundV2.sol:656`) is inferred from the successful `pay()`;
  the call trace was not read.
- **Test USDT from a WBT swap (7 Nov).** The buyer wallet wrapped 1.5 WBT to WWBT at 07:14 IST, block 12,419,473
  (tx `0x4cb0b0a593faa41e4f721cd46ab25e318acef6a6d97ad798cbd40c922b1e1c42`). At block 12,419,506 it swapped the WWBT
  for 109.248354 USDT through the explorer-verified `UniversalRouter`, `0xbCB198083504E31293bC3765b3c791cF2B2202d8`
  (tx `0x434d460c797dbf18e2686d182319bda7f47dfe9489c101839f43cd22cb117f4b`). Which front end sent it: not checked.

## What was hard or missing

- **Permit domain version is not discoverable.** USDT (`0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`) has no
  `version()` getter (the call reverts). We found the EIP-712 domain (name "Tether USD", version "1", chainId 1874)
  only by computing it and matching `DOMAIN_SEPARATOR`
  (`0xcdcfacb6b15c8238b4e5fbb47bdb83b7f83f50a531d264bf9763d2bd1d3d2a25`). One line in the docs would save every
  permit integrator that step.
- **No cross-chain route in.** Relay's chain API (checked 6 Nov) lists no Whitechain: none among its 58 mainnet
  chains, and its testnet list has only Base Sepolia and Sepolia (re-checked 07:40 IST, 7 Nov: 57 mainnet chains,
  still no Whitechain). So "pay from any chain, settle on Whitechain" is on our roadmap, waiting on that listing.
- **Local testing of P-256.** Inside `forge test` (Foundry 1.7.1), a call to `0x100` with a valid `vm.signP256`
  signature returned success with empty data, with `--evm-version` cancun, prague and osaka and with
  `-n optimism`, so our unit tests etch a Solidity P-256 verifier at `0x100`. `anvil --hardfork osaka` does verify at
  `0x100`: our relayer's local test checks the real Chrome fixture signature against it. (Plain `anvil` 1.7.1 also
  returned 1 for one `vm.signP256` signature in a single `cast call`; not tested further.) Not Whitechain's bug, but
  a docs note ("P-256 at 0x100; for local tests use `anvil --hardfork osaka` or etch a verifier") would help.
- **Getting test USDT.** The faucet gives 2 WBT per day and needs a GitHub account older than 30 days. There is no
  USDT faucet, so every tester has to get WBT first and then swap it (the swap itself worked, above).
- **`eth_getLogs` is capped at 10,000 blocks.** A query from block N to N+10,000 works. N to N+10,001 returns
  `-32602 query exceeds max block range 10000` (measured 07:48 IST, 7 Nov). With 1 s blocks that is under 3 hours of
  history per call, so our dashboard and receipt pages read events in chunks. A documented limit, or a hosted
  indexer, would help every app that shows payment history.

## What kept us on one chain

We planned Sitebound for several EVM chains, with Whitechain as the home chain and "pay from any chain" for buyers.
These blocked it this weekend:

- **No bridge route into Whitechain** (Relay, above). Without one, a buyer holding USDT elsewhere cannot pay a
  Whitechain site in one step. A listing on Relay or another bridge would unblock it. Other bridges: not checked.
- **Gas for the relayer.** Our relayer pays the gas for every register, setup and payment, so each chain needs a
  funded hot wallet. On Whitechain Sepolia the faucet gives 2 WBT a day, which also had to cover deploys and
  rehearsals. Whitechain's own gas was cheap: one payment cost 0.0015 WBT, and the relayer held 1.96 WBT at
  07:48 IST, 7 Nov. The constraint is a funded and watched wallet on every extra chain. Running those was beyond a
  two-person testnet budget (our view).
- **No USDT faucet.** Every test payment needs test USDT, and the only path we found is a WBT swap (not checked).
  A USDT faucet next to the WBT one would make demos and judging much easier.

## What broke

- **Blockscout contract verification (6 Nov, measured).** Contract `0x43bb27f7079c76D6F0Fa4b4e6d69843e0457DF73`.
  `forge verify-contract --verifier blockscout` and a direct POST of the standard-JSON input to
  `/api/v2/smart-contracts/<addr>/verification/via/standard-input` both end in "Fail - Unable to verify". The local
  build output equals the creation bytecode on the explorer, including the metadata hash, so the source matches.
  `/api/v2/smart-contracts/verification/config` reports `is_rust_verifier_microservice_enabled: true` but returns an
  empty `solidity_compiler_versions` (and `vyper_compiler_versions`), so the verifier service looks unreachable. Build
  settings used: solc 0.8.28, via-IR, optimizer 200 runs, cancun. Not checked: other compiler versions or the UI path.
- **Sourcify worked where Blockscout did not (6 Nov, measured).** Sourcify reports `exact_match` for both the
  creation and the runtime code of the same contract (verified 16:59 IST):
  https://repo.sourcify.dev/1874/0x43bb27f7079c76D6F0Fa4b4e6d69843e0457DF73. During that verification, Blockscout
  answered Sourcify's job with HTTP 403 "temporarily unavailable". So the source verifies, and the problem looks to
  be in the explorer's verification path (inferred).
- **When it stopped (measured 17:10 IST, 6 Nov).** The explorer's 40 most recently verified contracts were verified
  between 12:09 and 15:03 IST, including three solc 0.8.28 via-IR builds, and none after that. So the verifier did
  work for these settings until about 15:03 IST. Whether our first failed attempts were before or after that: not
  checked.
- **Update, 23:06 IST, 6 Nov (measured): verification works again for our V2 contract.**
  - SiteboundV2 `0x64117398C837a8708a816818b31C36Df5a968596` shows as verified on the explorer: `is_verified: true`, name SiteboundV2,
    compiler v0.8.28, `verified_at` 23:00:53 IST.
  - Sourcify reports `exact_match` for its creation and runtime code (23:00:50 IST).
  - V2 went to Sourcify first and then to Blockscout. Why it worked this time: not checked.
  - The v1 contract above is still unverified on the explorer (`is_verified: false` at 23:06 IST).

## Not checked yet

- Gas of `pay()` beyond the one sample above (305,060).
- Which front end (YetiTrade or another) sent the WBT to USDT swap above.
- The v1 contract's current explorer status: the explorer API returned no verification fields for it at 07:48 IST,
  7 Nov (last measured unverified at 23:06 IST, 6 Nov).
