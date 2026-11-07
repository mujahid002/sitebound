# For websites: settings, server check, quotes

What a website owner can configure on SiteboundV2, and how to confirm a payment on the server before shipping. Back to the [README](../README.md).

## Website settings (SiteboundV2)

The first wallet of a site's split is its **owner**. Every change below bumps the site's config version. The
buyer's passkey signs that version, so a payment signed before a change cannot execute after it.

- **Split payouts.** Up to 5 wallets, in basis points summing to 10000. The owner gets the rounding dust. Changing
  the split needs the attestors and waits `delay` (1 hour on the deployment).
- **Drop a recipient.** The owner can remove a non-owner recipient at once, for example one the token refuses to pay.
  Its share goes to the owner.
- **Refund operator, admins (up to 3), quote signer.** The owner sets each one and it takes effect after `delay`.
  Removing an admin is immediate. When the split moves to a new owner, all of them are cleared.
- **Refunds** go only to the wallet that paid, and are paid from the refunder's own funds. The total is capped at
  the payment's amount; the relayer fee is not refundable.
- **Freeze.** The owner's freeze stops payments and split changes until the owner lifts it. An admin's freeze stops
  payments for 72 hours and cannot cancel a pending split.
- **Guardian.** It is fixed at deploy (optional) and can pause new payments. It cannot move funds or stop refunds.

## Verify on your server before shipping

The `sitebound:paid` event comes from the page, and any script on the page can fire it. Before you ship, ask the
chain. `web/merchant/sitebound-merchant.mjs` runs in Node with ethers v6 (`npm install ethers@6`, then copy the file):

```js
import { verifyPayment } from './sitebound-merchant.mjs';

const r = await verifyPayment({
  rpcUrl: 'https://rpc.testnet.whitechain.io',
  contract: SITEBOUND_ADDRESS,
  expectedSite: 'https://site.example', // your origin, exactly as the browser reports it
  expectedAmount: '12.00',              // your price for this order, not the page's
  orderId: 'A123',
  paymentId: fromTheBrowser,            // optional: only compared, never trusted
});
if (!r.ok) throw new Error(`not paid: ${r.reason}`);
```

It recomputes the payment id from your site and order, then reads `payments(id)` on chain. It requires a payer, your
site, the exact amount, and nothing refunded. Use random order ids: anyone can pay an unused one at their own cost.
In e2e it accepts a real payment and refuses five wrong claims: a different amount, another order's id, an unpaid
order, a refunded order, and another site. The demo site runs the same check in the page (a real website runs it on
its server): a forged `sitebound:paid` gets "Not shipped", a real payment "Order confirmed".

### Merchant quotes (optional)

Without a quote, hacked page code can ask the buyer for a different amount, and only the buyer reading the frame
stops it. A site can name a **quote signer** (`setQuoteSigner`, takes effect after `delay`). From then on every
payment must carry a quote that the site's backend signs for that site, order and amount:

```js
import { Wallet } from 'ethers';
import { signQuote } from './sitebound-merchant.mjs';

const quote = await signQuote(new Wallet(process.env.SITEBOUND_QUOTE_KEY), {
  chainId: 1874, contract: SITEBOUND_ADDRESS, token: USDT_ADDRESS,
  site: 'https://site.example', order: 'A123', amount: '12.00', // expires in 15 minutes by default
});
// <sitebound-pay amount="12.00" order="A123" quote="${quote}"></sitebound-pay>
```

A page that changes the amount gets "bad quote", and one without a quote gets "quote required" (both in e2e). The
quote signer can be a contract wallet (ERC-1271).
