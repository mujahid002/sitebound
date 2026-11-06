# Whitechain builder feedback

From building Sitebound on Whitechain Sepolia (chain 1874) at ETHGlobal Mumbai, 4 to 7 Nov 2026.
Draft. Only things we measured; the rest is marked "not checked".

## What was easy

- **P-256 precompile.** `0x100` on Whitechain Sepolia returns 1 for the RIP-7212 test vector (4 Nov) and for a
  Foundry `vm.signP256` signature (6 Nov, `cast call`). Sitebound verifies every passkey signature on-chain, so
  this is the feature the whole design rests on.
- **USDT has EIP-2612 `permit`.** Buyers can grant the allowance with a signature, and a relayer pays the gas.
  The ERC-3009 typehashes are present too. A real signed permit on Whitechain is not checked yet.
- **Public RPC.** `https://rpc.testnet.whitechain.io` works with `cast` without a key.

## What was hard or missing

- **Permit domain version is not discoverable.** USDT (`0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`) has no
  `version()` getter (the call reverts). We found the EIP-712 domain (name "Tether USD", version "1", chainId 1874)
  only by computing it and matching `DOMAIN_SEPARATOR`
  (`0xcdcfacb6b15c8238b4e5fbb47bdb83b7f83f50a531d264bf9763d2bd1d3d2a25`). One line in the docs would save every
  permit integrator that step.
- **No cross-chain route in.** Relay's chain API (checked 6 Nov) lists no Whitechain: none among its 58 mainnet
  chains, and its testnet list has only Base Sepolia and Sepolia. So we could not offer "pay from any chain" and
  dropped it.
- **Local testing of P-256.** Inside `forge test` (Foundry 1.7.1), a call to `0x100` with a valid `vm.signP256`
  signature returned success with empty data, with `--evm-version` cancun, prague and osaka and with
  `-n optimism`, so our unit tests etch a Solidity P-256 verifier at `0x100`. `anvil --hardfork osaka` does verify at
  `0x100`: our relayer's local test checks the real Chrome fixture signature against it. (Plain `anvil` 1.7.1 also
  returned 1 for one `vm.signP256` signature in a single `cast call`; not tested further.) Not Whitechain's bug, but
  a docs note ("P-256 at 0x100; for local tests use `anvil --hardfork osaka` or etch a verifier") would help.
- **Getting test USDT.** The faucet gives 2 WBT per day and needs a GitHub account older than 30 days. There is no
  USDT faucet; the path is swapping WBT to USDT on YetiTrade (not checked yet).

## What broke

- **Blockscout contract verification (6 Nov, measured).** Contract `0x43bb27f7079c76D6F0Fa4b4e6d69843e0457DF73`.
  `forge verify-contract --verifier blockscout` and a direct POST of the standard-JSON input to
  `/api/v2/smart-contracts/<addr>/verification/via/standard-input` both end in "Fail - Unable to verify". The local
  build output equals the creation bytecode on the explorer, including the metadata hash, so the source matches.
  `/api/v2/smart-contracts/verification/config` reports `is_rust_verifier_microservice_enabled: true` but returns an
  empty `solidity_compiler_versions` (and `vyper_compiler_versions`), so the verifier service looks unreachable. Build
  settings used: solc 0.8.28, via-IR, optimizer 200 runs, cancun. Not checked: other compiler versions or the UI path.

## Not checked yet

- A real signed USDT `permit` submitted on Whitechain.
- The YetiTrade WBT to USDT swap.
- Gas costs of `pay()` on Whitechain.
