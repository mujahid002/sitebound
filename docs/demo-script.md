# Sitebound demo video: storyboard (about 3:55)

Seven scenes in order, opening on the attack. Each one lists its time slot, page URL, on-screen steps and spoken
line. Button and heading text is copied from the code as of 1c70197 (6 Nov 2026, 15:45 IST). The landing has changed
since (4243dda, a five-step setup wizard), so re-copy scene 2's text before recording: not checked. Wallet pop-ups,
Touch ID sheets and explorer pages are not our code, so their wording is described, not quoted.
Cut every wait for a block in editing. Whitechain's block time is not checked.

Hosts (layout from `deploy/pages.sh`; status checked 15:29 to 15:43 IST):
- Frame host `https://sitebound-pay.pages.dev` serves `web/` without `dev/`, `demo-shop/` and `attack/`. Since
  27f6daf the landing is the site root `/`, and `deploy/pages.sh` adds 301 redirects from `/landing` and `/landing/`
  to `/`. Live after the next deploy: not checked.
  - Measured before that change: `/button/sitebound.js` 200.
  - `/frame/index.html?...` redirects (308) to `/frame/?...` with the query kept.
  - The live `/config.js` has the contract address and the relayer URL.
- Demo host `https://sitebound-demo.pages.dev` serves the demo shop at `/` and the attack pages at `/attack/`.
  - Measured: `/shop.css` 200 (CSS) and `/attack/` 200. `/attack/classic.html` redirects (308) to `/attack/classic`.
  - Unknown paths return 200 with the demo shop's HTML (Pages fallback), so a 200 on a wrong URL proves nothing.
- Fake-site host `https://sitebound-phish.pages.dev` (`fakeShop` in `web/config.js`) serves the attack pages for scene 5.

## Before recording (not done yet unless marked measured)

- [ ] **Attack pages' stylesheet on the demo host.** They load `../demo-shop/shop.css`. At 15:43 IST that path
  returned the demo shop's HTML, so scenes 1 and 5 rendered unstyled. `deploy/pages.sh` now copies `shop.css` to
  `demo-shop/shop.css` on the demo and fake-site hosts. Live after a redeploy: not checked.
- [ ] **Redeploy the frame host** so `web/assets/` (favicons, share image) goes live. `/assets/favicon.svg` was 404 at 15:32 IST.
- [ ] **Register the demo shop** on the contract the frame uses (V2 after the migration: every site registers again).
  - On v1, `sites(keccak("https://sitebound-demo.pages.dev"))` had payout 0x0 at 15:28 IST, so it was not registered.
  - pages.dev gives us no DNS, so `worker/wrangler.toml` pins it:
    `DEMO_SITES = "https://sitebound-demo.pages.dev=0x2bb9…F275"`. The Worker must be deployed with that.
  - Registration happens once. After it, the onboarding page opens on "Registered on Sitebound". Either record scene 2
    in one take, or register beforehand and narrate over the registered state.
- [ ] **Relayer.**
  - Measured at 15:29 IST: `https://sitebound-relayer.sitebound-relayer.workers.dev/health` answers `ok: true`, and its
    address `0xDf54…5b4A` has `isAttestor = true` and 1.99 WBT.
  - `/setup` and `/pay` against the live contract: not checked.
  - Daily caps eat into rehearsals: 3 setups per wallet, 20 pays per passkey, 3 registers per site.
- [ ] **Buyer wallet.** A browser wallet (MetaMask or Rabby) holding testnet USDT `0xcedf…55a7`:
  - 12.01 for scene 4 (12.00 plus the 0.01 relayer fee).
  - The relayer path needs no WBT. "Pay from my wallet" does.
  - Where to get testnet USDT: not checked.
- [ ] **Payout wallet** (the demo shop's). It needs WBT for two transactions in scene 6 (approve, then refund). The
  refund comes out of its own USDT, which it received in scene 4.
- [ ] **Browser.** Desktop Chrome, with pop-ups allowed for `sitebound-pay.pages.dev` (setup window).
  - Chrome writes `topOrigin`. Safari may omit it (not measured), and Firefox is not checked.
  - The passkey lives under rpId `sitebound-pay.pages.dev`.
- [ ] **Third origin for scene 5.**
  - `deploy/pages.sh` deploys the attack pages to the `sitebound-phish` Pages project. Links marked `data-fake` point at
    `<fakeShop>/attack/phish.html` (`web/attack/attack.js:94`).
  - The overlay's site name comes from `demoShop` in `web/config.js` (`web/attack/attack.js:92`).
  - Live: not checked.
- [ ] **Explorer.** The v1 contract source is not verified there: `/api/v2/addresses/0x43bb…` returned `is_verified: false` at 15:28 IST.
  `WHITECHAIN_FEEDBACK.md` records Blockscout verification failing (the verifier lists no compilers). Until that is
  fixed, scene 7 shows the transactions, not the source.
- **Fallback: local stack.**
  - Run `python3 web/dev/serve.py`. The demo shop is on `http://127.0.0.1:8001` and the frame on `http://localhost:8002`. For scene 5, also run
    `python3 -m http.server 8003 --bind 127.0.0.1 --directory web`.
  - On localhost, `config.js` uses address 0x0. The frame then shows "Sitebound is not deployed yet: set address in config.js."
    and disables Pay, so locally only scene 1 and the site line in scene 5 work.
  - On-chain scenes need a local anvil, the way `e2e/run.mjs` does it (headless). A headed manual version is not built:
    not checked.

## 1. Hacked script: classic checkout vs Sitebound (0:00 to 0:50)

URLs: `https://sitebound-demo.pages.dev/attack/classic.html`, then `.../attack/sitebound.html`.

1. Classic: click **Copy** next to `0x5409…5409`. Paste into "Paste what you copied here, as you would in your wallet:".
2. Click **Inject the hacked script**. The page address becomes `0xbad0…0bad`, and the log shows "addresses found and swapped on the page: 1".
3. Clear the field, click **Copy** again and paste. You get `0xbad0…0bad`. The log adds "clipboard: the address the buyer copied was replaced on the way in".
4. Click "Next: the same script against the Sitebound checkout".
5. On sitebound.html, click **Inject the hacked script**. The log shows "addresses found and swapped on the page: 0" and
   "<sitebound-pay> elements: 1. Attributes: amount, order. None of them is a payee."
6. Click **Pay 16.50 USDT**. The frame still says "Pay 16.50 USDT to sitebound-demo.pages.dev". Close it with ×.
   Don't pay here: the buyer has no passkey until scene 3.

Spoken:
> "Here's the attack that keeps happening: a compromised checkout script swaps the address on the page and in the
> clipboard. Same script on the Sitebound checkout: there's no address to swap, and the frame is on another origin,
> so the page can't touch it. Hacked code can still change the amount, but the buyer sees it and confirms it, and
> the caps bound it."

## 2. Website onboarding (0:50 to 1:30)

URL: `https://sitebound-pay.pages.dev/`. The setup opens inline on the same page.

1. Landing. Hold on the hero for 2 seconds: "Addressless checkout for your website.", the website chips orbiting the
   search bar, and the "Live on Whitechain Sepolia" chip. Move the pointer once: the dot field lights up under it.
2. Click the search bar ("yourwebsite.com"). Type `sitebound-demo.pages.dev`, then click **Bring your website** (or
   click the `sitebound-demo.pages.dev` chip). The setup opens below the hero on "Connect your website", with "Four
   short steps. Your checkout code never holds a payment address."
3. Step 1 "Connect your wallet": click **Connect wallet** and approve in the wallet. Use the payout wallet pinned in DEMO_SITES.
4. Step 2 "Add the DNS record": show the TXT Name `_sitebound.sitebound-demo.pages.dev` and the Value `sitebound=0x…`.
   Click **Verify domain**. The step summary becomes "Record found".
5. Step 3 "Register your site": click **Register site**. The button shows "Waiting for the chain…", then the panel
   reads "Registered on Sitebound" with the badge "Active".
6. Step 4 "Paste the snippet": point at the code (no address in it), then click **Copy snippet**.

Spoken:
> "So Sitebound removes the address. A site owner types the domain, connects the wallet that gets paid, proves the domain with
> one DNS record, and the relayer registers that wallet on Whitechain for this site only. On this pages.dev demo we
> can't add DNS, so the relayer pins this one site's wallet instead. The snippet the owner pastes has no address in it."

## 3. Buyer first-time setup (1:30 to 2:05)

URL: `https://sitebound-demo.pages.dev/` (the setup window opens at `https://sitebound-pay.pages.dev/frame/setup`).

1. On "Brew gear", click **Add** on "Ceramic pour-over dripper" (12.00), then **Checkout**.
2. Click **Pay 12.00 USDT**. The frame opens with "Checkout", "12.00 USDT", "Pay 12.00 USDT to **sitebound-demo.pages.dev**"
   and "Order HCS-…".
3. Click the **Set up** link ("First time? Set up"). A window opens: "Pay with a passkey, on any site".
4. Click **Connect wallet** and approve. Whitechain Testnet is added if needed.
5. Show the limits: "Per payment (USDT)" 50, "Total (USDT)" 200, "Expires in (days)" 30. Click **Create passkey and sign**.
6. Touch ID creates the passkey. Then the wallet asks for 2 signatures, and no gas. The step list ticks through
   "Create your passkey", "Sign the USDT allowance (permit)", "Sign the passkey binding and limits" and "Save it on Whitechain".
7. "Done. Each payment is now one Touch ID." Click **Back to checkout**. The frame now reads "Setup complete. Pay with your passkey."

Spoken:
> "The buyer sets up once. They connect a wallet, pick limits (50 per payment, 200 in total, 30 days) and make a
> passkey. The wallet signs twice, an allowance and a binding, and the relayer saves both on-chain, so the buyer pays no gas.
> Sitebound can never move more than these limits."

## 4. Buyer pays with Touch ID (2:05 to 2:30)

URL: the same demo shop tab, with the frame open.

1. Click **Pay with passkey**. Point at the note "Adds a 0.01 USDT relayer fee, so you need no gas."
2. Touch ID. The status reads "Sending…" and then "Confirming on Whitechain…" (cut the wait).
3. The receipt shows "Paid" with Amount 12.00 USDT, To sitebound-demo.pages.dev, Order HCS-… and the Transaction hash. Click **Done**.
4. The demo shop shows "Order confirmed" and "Thanks. Order HCS-… is paid."

Spoken:
> "From now on a payment is one Touch ID. The frame comes from Sitebound's own origin, and it shows the site the browser reports and the amount.
> The browser writes that site into the signature, and the contract pays only the wallet registered for it.
> The website's page never names the payee."

## 5. Fake site embedding the real frame (2:30 to 3:00)

URL: `https://<third-origin>/attack/phish.html` (not created yet; see the checklist).

1. Point at "This page runs on https://<third-origin>".
2. Click **Pay 16.50 USDT**. The frame shows "Pay 16.50 USDT to **<third-origin>**", the fake's origin, not the real site's.
3. Click **Pay with passkey** and use Touch ID. Expect a relayer error carrying "site not registered" (not checked live). No money moves.
4. Close the frame. Click **Draw the overlay**, then **Pay 16.50 USDT** again. The fake site covers the frame's site line.

Spoken:
> "A copy of the website on another domain can embed the real frame. The frame shows the domain the buyer is actually
> on, and the browser signs that domain, so this page can only pay its own registry entry. It has none, so the
> payment fails. The honest limit: a page can draw over the frame, and if the attacker registered their own domain, a
> buyer fooled by the overlay pays the attacker. Sitebound shows the real site; it doesn't vouch for it."

## 6. Dashboard: refund and CSV (3:00 to 3:35)

URL: `https://sitebound-pay.pages.dev/dashboard/?site=https%3A%2F%2Fsitebound-demo.pages.dev`

1. Click **Connect wallet** (top right) with the payout wallet. The chip reads "payout wallet".
2. Under "Orders", find the scene 4 row (HCS-…, 12.00 USDT, "Paid"). Click **Refund**.
3. The dialog reads "Refund HCS-…" and "Goes back to 0x…", which is the buyer, and "Refunds can only go to the wallet that paid."
   The amount is prefilled with the full 12.00. Click **Refund**.
4. The wallet asks twice: "Approving USDT…", then "Refunding…" (cut the wait). "Refund sent" appears with "The buyer's wallet has the USDT back."
   Click **Done**. The row now reads "Refunded".
5. Click **Export CSV**. `sitebound-sitebound-demo.pages.dev-orders.csv` downloads. Open it to show order_id, buyer,
   amount_usdt, refunded_usdt, status and tx_hash.

Spoken:
> "The website's dashboard reads straight from the chain; nothing is stored on a Sitebound server. Refunds go back only
> to the wallet that paid, because the contract picks the address, not the website. Export everything as CSV for the books."

## 7. On the explorer (3:35 to 3:55)

URLs:
- `https://explorer.testnet.whitechain.io/tx/<scene 4 tx>`, reached from "View the payment on the explorer" in the
  demo shop or "Tx" on the dashboard.
- `https://explorer.testnet.whitechain.io/address/<SITEBOUND_V2_ADDRESS: filled in after the V2 deploy>` (v1 until
  then: `0x43bb27f7079c76D6F0Fa4b4e6d69843e0457DF73`). It is reached from the landing's footer strip "Live on
  Whitechain Sepolia" → **View on the explorer** (`https://sitebound-pay.pages.dev/#live`). That link follows
  `web/config.js`.

1. Show the payment transaction: USDT from the buyer to the demo shop's payout wallet (12.00) and to the relayer (0.01).
   How the explorer labels these: not checked.
2. On the landing, click the "Live on Whitechain Sepolia" chip, then **View on the explorer**. Show the contract's
   transactions (register, bind, pay, refund). Show the source only if verification works by then.

Spoken:
> "It's all on Whitechain Sepolia: the payment, the refund, and the contract that decides who gets paid. Sitebound is
> testnet-only and not audited. Kill the checkout address."

Explorer: the page HTML does not contain the word "Blockscout" (0 hits), but its `/api/v2/addresses/<addr>` answers in
Blockscout's v2 format and `forge verify-contract --verifier blockscout` talks to it (`WHITECHAIN_FEEDBACK.md`). Say
"the Whitechain explorer" on camera to be safe.

Runtime: 50 + 40 + 35 + 25 + 30 + 35 + 20 = 235 s = 3:55.
