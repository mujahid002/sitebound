# Development

Run the contracts, the relayer and the pages locally, deploy, and add a website without DNS for a demo. Back to the [README](../README.md).

## Setup and local dev

Requires Foundry, Node, Python 3 and Chrome (the only browser measured so far).

```sh
forge install foundry-rs/forge-std   # lib/ is not committed
forge test                           # v1, SiteboundV2 and the V2 invariant suites
node web/dev/check-lib.mjs           # the frame's encoders and the merchant helper, on the real Chrome fixture
(cd worker && npm install && node test/local.mjs)  # relayer against anvil, then under wrangler dev
(cd e2e && npm install && npm test)                # headless Chromium: setup, pay, refund, demo site, quotes
```

`forge test` has no P-256 precompile, so the tests etch a Solidity verifier (`test/utils/P256Verifier.sol`) at
`0x100`. One test replays a real Chromium assertion from a cross-origin iframe
(`test/fixtures/frame_assertion_v2.json`, captured by `e2e/capture-fixture.mjs`). e2e expects Chrome for Testing
from Playwright's cache, or `CHROME=<binary>`.

To run the web pages locally (the site and the frame must be different origins):

```sh
python3 web/dev/serve.py
# site  http://127.0.0.1:8001   (web/ served with no-store)
# frame http://localhost:8002   (the same web/ folder, a different origin)
```

- Demo site: http://127.0.0.1:8001/demo-shop/
- Attack demos: http://127.0.0.1:8001/attack/. For the fake-site page, serve `web/` on a third origin too:
  `python3 -m http.server 8003 --bind 127.0.0.1 --directory web`, then open http://127.0.0.1:8003/attack/phish.html.
- Local passkeys use rpId `localhost`, so the frame must be on `localhost`.
- `web/config.js` holds the chain id, RPC, explorer, contract address and relayer URL for the frame.

Hosting: `deploy/pages.sh` deploys the frame host, the demo site and the fake-site copy to Cloudflare Pages (needs
`wrangler login`). A real website loads the button from the frame host, because the button opens the frame next to
its own script URL.

### Deploy the contract

```sh
ATTESTORS=<addresses, comma-separated, ascending> THRESHOLD=1 \
FRAME_ORIGIN=https://<frame host> RP_ID=<frame host> DELAY=3600 GUARDIAN=<optional> \
  forge script script/Deploy.s.sol --rpc-url $RPC_URL --account <keystore> --broadcast
```

The token is Whitechain Sepolia USDT `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` (6 decimals, so the on-chain
relayer fee cap is 1 USDT). `DELAY` must be 1 s to 30 days. After a V2 deploy:
- point `web/config.js` and `worker/wrangler.toml` at it;
- fill in `web/verify/expected.json`;
- register the sites again.

Buyers set up again too: v1 bindings and allowances do not carry over.

## Add a website without DNS (demo/admin only)

For the demo, the relayer can add any website without a DNS record. This is off unless the Worker has the
`ADMIN_TOKEN` secret.

```sh
sh scripts/add-site.sh https://site.example 0xPayoutAddress   # prints the register tx hash and an explorer link
```

- The script stores the payout in the relayer's KV (`POST /admin/sites` with `Authorization: Bearer $ADMIN_TOKEN`),
  then calls `/register`. The relayer signs the same attestation it signs for a DNS-verified site.
- It reads `ADMIN_TOKEN` from the environment or `.env`. `GET /admin/sites` lists the added sites.
  `DELETE /admin/sites` with `{"site": ...}` removes one; the on-chain registration stays.
- The relayer checks `DEMO_SITES` first, then these entries, then DNS. An entry overrides the site's DNS record until
  it is deleted.
- Whoever holds the token can register any website: the power the relayer's attestor key already has. See
  [docs/THREAT-MODEL.md](THREAT-MODEL.md).
