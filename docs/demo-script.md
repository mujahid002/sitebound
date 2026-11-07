# Sitebound demo video: storyboard (about 2:55)

Four scenes in order: the attack, onboarding a real domain, a coffee payment with Touch ID, the explorer.
Target length 2 to 4 minutes. No music, voice only. Record at 720p or higher.

Each scene lists its time slot, page URL, on-screen steps and spoken line. Button and heading text is copied from the
code at 53eddf0 (7 Nov 2026). Wallet pop-ups, Touch ID sheets and explorer pages are not our code, so their wording is
described, not quoted. Cut every wait for a block in editing. Whitechain's block time is not checked.

The real domain is `https://0xmujahid.xyz`, the owner's portfolio. It has a "Buy me a coffee" section (3, 5 and 10
USDT) that uses the `<sitebound-pay>` button (`web/portfolio/index.html`). The owner onboards that domain in scene 2,
then a buyer pays it in scene 3.

Hosts:
- Frame host `https://sitebound-pay.pages.dev`: the landing and onboarding wizard at `/`, the button script at
  `/button/sitebound.js`, the frame at `/frame/`. Live state of the latest deploy: not checked.
- Demo host `https://sitebound-demo.pages.dev`: the demo site at `/` and the attack pages at `/attack/`.
  Unknown paths return 200 with the demo site's HTML (Pages fallback), so a 200 on a wrong URL proves nothing.
- Real domain `https://0xmujahid.xyz`: loads the button from the frame host.

## Before recording (not done unless marked)

- [ ] **Attack pages' stylesheet.** They load the demo site's stylesheet by a relative path. At 15:43 IST on 6 Nov that path returned HTML, so
  the pages rendered unstyled. `deploy/pages.sh` now copies it. Live after a redeploy: not checked.
- [ ] **Frame host redeploy**, so the current frame, wizard and `web/assets/` are live. Not checked.
- [ ] **0xmujahid.xyz must not be registered yet.** If it has a payout wallet already, the wizard offers a payout change
  that waits `delay` (1 hour), which cannot be filmed. Read it from the contract with
  `splitOf(keccak256("https://0xmujahid.xyz"))`.
  - **Measured 07:25 IST, 7 Nov: it is registered** (block 12,416,278, 06:20 IST, payout `0x0eCF…709f`). So scene 2
    cannot film a first registration on this domain: film the registered state (the fallback below), or onboard a
    different, unregistered domain.
- [ ] **DNS access for 0xmujahid.xyz.** The wallet is created on camera, so the TXT value is only known in step 2 of the
  wizard. Have the DNS provider's page open in another tab. The wizard checks every 5 s for about 3 minutes, so a slow
  provider needs the cut.
  - Fallback without DNS: create the wallet on camera, then run `sh scripts/add-site.sh https://0xmujahid.xyz <wallet>`
    off camera (needs the admin token; see README) and film the registered state instead of the DNS step.
- [ ] **Relayer.** Measured at 15:29 IST on 6 Nov: `/health` answers `ok: true` and its address `0xDf54…5b4A` is the
  attestor with 1.99 WBT. `/register` and `/pay` against the live contract: not checked. Daily caps eat into
  rehearsals: 3 setups per wallet, 20 pays per passkey, 3 registers per site.
- [ ] **Buyer, set up once before recording.** Scene 3 is a paying buyer, not a first-time one.
  - A browser wallet (MetaMask or Rabby) with testnet USDT `0xcedf…55a7`: at least 3.01 (3 plus the 0.01 fee).
    It needs no WBT. Where to get testnet USDT: not checked.
  - On a first click of **Confirm payment**, the frame opens the setup window (or open
    `https://sitebound-pay.pages.dev/frame/setup.html` yourself). It reads "Set up once, then pay with Touch ID".
    Click **Connect wallet** and pick the wallet from the chooser, keep the limits (50 per payment, 200 total, 30
    days), click **Confirm with Touch ID**: Touch ID creates the passkey, then the wallet signs twice. It reads "Done.
    From now on each payment is one Touch ID." The buyer pays no gas for any of it. Do this before recording, so
    scene 3 is one Touch ID.
- [ ] **Browser.** Desktop Chrome, pop-ups allowed for `sitebound-pay.pages.dev`. Chrome writes `topOrigin`. Safari
  may omit it (not measured), and Firefox is not checked. The passkey lives under rpId `sitebound-pay.pages.dev`, so
  use the same Chrome profile for setup and for scene 3.
- [ ] **Screen recording**, not tab recording, so the Touch ID sheet is in the shot. Which recorder captures it: not
  checked. Rehearse once.
- [x] **Explorer** (measured 6 Nov). V2's source is verified there: `is_verified: true`, name SiteboundV2, solc v0.8.28.
  The deprecated v1 is unverified. Don't show it.
- **Fallback: local stack.** `python3 web/dev/serve.py`. On localhost `config.js` uses address 0x0, so the frame shows
  "Sitebound is not deployed yet" and disables Pay. Locally only scene 1 works.

## 1. Hacked script: classic checkout vs Sitebound (0:00 to 0:50)

URLs: `https://sitebound-demo.pages.dev/attack/classic.html`, then `.../attack/sitebound.html`.

1. Classic: click **Copy** next to `0x5409…5409`. Paste into "Paste what you copied here, as you would in your wallet:".
2. Click **Inject the hacked script**. The page address becomes `0xbad0…0bad`, and the log shows "addresses found and swapped on the page: 1".
3. Clear the field, click **Copy** again and paste. You get `0xbad0…0bad`. The log adds "clipboard: the address the buyer copied was replaced on the way in".
4. Click "Next: the same script against the Sitebound checkout".
5. On sitebound.html, click **Inject the hacked script**. The log shows "addresses found and swapped on the page: 0" and
   "<sitebound-pay> elements: 1. Attributes: amount, order. None of them is a payee."
6. Click **Pay 16.50 USDT**. The frame, headed "Confirm payment", names the website, `sitebound-demo.pages.dev`, next
   to "Website". Close it with ×. Don't pay here.

Spoken:
> "Here's the attack that keeps happening: a compromised checkout script swaps the address on the page and in the
> clipboard. Same script on the Sitebound checkout: there's no address to swap, and the frame is on another origin,
> so the page can't touch it. Hacked code can still change the amount, but the buyer sees it and confirms it."

## 2. Onboarding 0xmujahid.xyz (0:50 to 2:00)

URL: `https://sitebound-pay.pages.dev/`. The wizard opens inline on the same page.

1. Landing. Hold on the hero for 2 seconds: "Addressless checkout for your website."
2. Click the search bar ("yourwebsite.com"), type `0xmujahid.xyz`, click **Bring your website**. The wizard opens:
   - "Set up payments for" over `0xmujahid.xyz`.
   - A five-step rail: Website, Wallet, DNS record, Register, Add to site.
3. The payout wallet is created automatically in this browser, with nothing to copy or save, and the wizard moves
   straight to the DNS step. The rail shows the address on Wallet. (A quiet "Back up this wallet" note is optional.)
   - Do not click **I already have a wallet** in the video. It keeps the old flow: **Connect wallet** with MetaMask or
     Rabby, on Whitechain Sepolia.
4. "Step 3 of 5", **Add one DNS record**: Type TXT, Name `_sitebound.0xmujahid.xyz`, Value `sitebound=<wallet>`. Click
   the copy buttons. If the wizard recognises the DNS provider it shows an **Open <provider> DNS settings** button:
   click it, add the record there, come back and click **Verify domain**. After that it checks every 5 seconds. Cut the wait. (If the provider adds the domain by itself, leave off the part after
   `_sitebound`; the wizard says so.)
5. "Step 4 of 5", **Register your site**: "Saves 0x… as the wallet that gets paid for this site only. Sitebound's
   relayer sends the transaction and pays the gas, so there is nothing to sign." Click **Register site**. The button
   reads "Waiting for the chain…" (cut it), then "Transaction sent:" with a link.
6. "Step 5 of 5, done", **Your site is live**: "USDT from buyers arrives at 0x…. Add the button below to start taking
   payments." Below it: the snippet ("Paste this where your checkout button goes. There is no payment address in it."). Click **Copy snippet**. Then cut to https://0xmujahid.xyz, which already carries the button.

Spoken:
> "Now a real website, 0xmujahid.xyz. The owner types the domain and Sitebound creates the payout wallet right here in
> the browser. No extension, no gas. The owner adds one DNS record to prove they own the
> domain, and the relayer registers that wallet on Whitechain for this site only. The snippet has no address in it."

## 3. Coffee payment with Touch ID (2:00 to 2:35)

URL: `https://0xmujahid.xyz/#coffee`. The section is "Buy me a coffee" with three tiers: 3, 5 and 10 USDT.

1. Point at the section text: "this page holds no wallet address, and the wallet that gets paid is registered
   on-chain for 0xmujahid.xyz".
2. Click **Pay 3 USDT**. The frame opens, headed "Confirm payment": Website `0xmujahid.xyz`, Amount "3 USDT", "Order
   COFFEE-…". The frame shows no fee line.
3. Point at the website and the amount: this is what the passkey signs. The buyer needs no gas, because the relayer
   pays the WBT.
4. Click **Confirm payment**. The status reads "Waiting for Touch ID…". Touch ID. Then "Paying. This takes a few
   seconds." (cut the wait). (A buyer who has not set up yet gets the setup window here instead, which is not filmed.)
5. The frame switches to "Paid" with Amount, Website, Order, Receipt and Transaction. It stays open on this page. Hold
   on it for 2 seconds, then click **Close**.
6. The page reads "Thank you. Payment confirmed on Whitechain." with **View the transaction**. Click it (scene 4).

Spoken:
> "A buyer who set up once pays with one Touch ID, like 3-D Secure for cards. The frame shows the website the browser
> reports, 0xmujahid.xyz, and the amount. The buyer needs no gas: the relayer sends the transaction. The page never
> names who gets paid. The contract pays the wallet registered for this domain."

## 4. On the explorer (2:35 to 2:55)

URLs:
- The "View the transaction" link: `https://explorer.testnet.whitechain.io/tx/<tx hash>`.
- `https://explorer.testnet.whitechain.io/address/0x64117398C837a8708a816818b31C36Df5a968596?tab=contract`.

1. Show the payment transaction: USDT from the buyer to the owner's payout wallet (3) and to the relayer (0.01, the
   relayer fee; the frame does not show it). The transaction is sent by the relayer. How the explorer labels these:
   not checked.
2. Open the contract address (the landing's "Live on Whitechain Sepolia" chip, then **View on the explorer**, or the URL
   above) and click the **Contract** tab. The source is verified (SiteboundV2, solc v0.8.28).

Spoken:
> "The payment is on Whitechain Sepolia, and so is the contract that decided who got paid. Sitebound is testnet-only
> and not audited."

Explorer: the page HTML does not contain the word "Blockscout" (0 hits), but its `/api/v2/addresses/<addr>` answers in
Blockscout's v2 format and `forge verify-contract --verifier blockscout` talks to it (`WHITECHAIN_FEEDBACK.md`). Say
"the Whitechain explorer" on camera to be safe.

Runtime: 50 + 70 + 35 + 20 = 175 s = 2:55.

## Not in this cut

These pages still work, but their wording was not re-checked after the frame text changed (0cbe632), so check it
before filming one.
- Fake site embedding the real frame: `/attack/phish.html` on the fake-site host (`sitebound-phish.pages.dev`; live: not
  checked). The frame names the fake's own domain and the payment fails with "site not registered".
- Dashboard: `https://sitebound-pay.pages.dev/dashboard/?site=0xmujahid.xyz`. Refund and CSV export. A
  created payout wallet needs a little WBT for the refund's two transactions.
- Demo site checkout at `https://sitebound-demo.pages.dev/`, with the forged "paid" event and the chain check.
