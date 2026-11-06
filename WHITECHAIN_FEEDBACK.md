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
- **Local testing of P-256.** `forge test` (Foundry 1.7.1) has no precompile at `0x100`: a call with a valid
  `vm.signP256` signature returns success with empty data, with `evm_version` cancun, prague and osaka, and also
  with `-n optimism`. We etched a Solidity P-256 verifier at `0x100` for tests. `anvil` 1.7.1 does return 1 for the
  same calldata (default and `--hardfork osaka`). Not Whitechain's bug, but a note in the docs ("P-256 at 0x100;
  in forge tests, etch a verifier or use anvil") would help.
- **Getting test USDT.** The faucet gives 2 WBT per day and needs a GitHub account older than 30 days. There is no
  USDT faucet; the path is swapping WBT to USDT on YetiTrade (not checked yet).

## Not checked yet

- Contract verification on Blockscout (`https://explorer.testnet.whitechain.io`).
- A real signed USDT `permit` submitted on Whitechain.
- The YetiTrade WBT to USDT swap.
- Gas costs of `pay()` on Whitechain.
