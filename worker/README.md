# Sitebound relayer (Cloudflare Worker)

Pays gas for four calls only: `register`, `token.permit`, `bind` and `pay`. Each one is simulated from the
relayer address first and refused with the revert reason if it would fail. There is no generic call endpoint.
`pay()` is permissionless, so this relayer can refuse a payment but can never redirect one: the payout comes from the
on-chain registry, never from request data.

| Endpoint | Body | Returns |
|---|---|---|
| `POST /dns/check` | `{site}` | `{ok, site, payout}` from TXT `_sitebound.<host>` = `sitebound=<payout>` |
| `POST /register` | `{site, payout}` | `{txHash}`; for an existing site `{txHash, pending:true, activeAt}` (the change waits for the contract's delay) |
| `POST /setup` | `{owner, permit?:{value,deadline,v,r,s}, bind:{credentialHash,pubX,pubY,perPayCap,totalCap,expiry,v,r,s}}` | `{txHash, permitTxHash?}` |
| `POST /pay` | PayInput fields (`relayerFee >= MIN_FEE`) | `{txHash, paymentId}` after 1 confirmation |
| `GET /health` | | `{ok, relayer, chainId}` |

Rules:
- `site` must be exactly a Chrome-serialized https origin (`https://shop.com`): no port, path, IP or uppercase.
- The DNS check (Cloudflare DoH, no DNSSEC requirement) is the one trusted step.
- `/setup`: if the permit simulation fails (for example on a token without permit), bind still goes through when
  `allowance(owner, Sitebound) >= totalCap`.
- Daily caps per UTC day: pay per credentialHash, setup per owner, register per site. A cap is counted only after the
  simulation passes.

## Config
- Secrets: `RELAYER_KEY` (the hot EOA; also the DNS attestor, so pass its address to the constructor) and `RPC_URL`.
- Vars in `wrangler.toml`: `CHAIN_ID`, `SITEBOUND_ADDRESS` (fill in after deploy), `TOKEN_ADDRESS`,
  `ALLOWED_ORIGINS` (comma list or `*`), `MIN_FEE` (default 10000 = 0.01 USDT), `PAY_DAILY_CAP` (20),
  `SETUP_DAILY_CAP` (3), `REGISTER_DAILY_CAP` (3).
- KV `CAPS`: run `npx wrangler kv namespace create CAPS`, paste the id into `wrangler.toml` and uncomment the block.
  Without it the caps live in isolate memory, which is fine for dev only.

## Run
```sh
npm install
npm test                # anvil --hardfork osaka (P-256 at 0x100) + forge create; needs foundry
npx wrangler login
npx wrangler secret put RELAYER_KEY
npx wrangler secret put RPC_URL
npx wrangler deploy
```
The test uses anvil's public dev keys and never reads `../.env`. It replays the real Chrome assertion in
`test/fixtures/frame_assertion.json` through `/pay`, with the contract placed at the fixture address. It then runs
the same checks under `wrangler dev` (`SKIP_WRANGLER=1` skips that part).

## Limits
- One EOA. Sends are serialized per isolate only, so two isolates can race on a nonce.
- KV is eventually consistent, so a cap can be exceeded slightly.
