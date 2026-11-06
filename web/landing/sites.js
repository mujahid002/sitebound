// The one list the orbit and the detail panel are drawn from. Add a site here and nothing else.
//
//   domain  what the chip shows, and the panel title
//   kind    'real'  a business that shows a payment address today (not a Sitebound customer): its chip opens the panel
//           'ours'  a Sitebound example: its chip opens the setup for that site
//   today   how the site takes crypto now, one sentence from its own page (the left column of the panel)
//   proof   the page that says it, https only (the "Source" link)
//   logo    a file under web/landing/logos/. If it is missing the chip keeps a letter mark. Never a third-party URL:
//           a hotlinked icon tells that host who visited.
//   origin  only when it is not https://<domain> (the local demo shop)
//
// Facts checked 7 Nov 2026 against each site's own page; quotes are the page's words.
const demo = window.SITEBOUND?.demoShop;
const host = (o) => { try { return new URL(o).host; } catch { return o; } };
const real = (domain, today, proof) => ({ domain, kind: 'real', today, proof, logo: `logos/${domain}.png` });

export const SITES = [
  demo && { domain: host(demo), origin: demo, kind: 'ours', today: '', proof: '', logo: '' },
  { domain: '0xmujahid.xyz', kind: 'ours', today: '', proof: '', logo: '' },
  real('surfercloud.com', 'Its blog shows a checkout with an address and QR code that “may change after this time.”',
    'https://surfercloud.com/blog/guide-to-acquiring-surfercloud-uhost-cloud-server-for-just-5-90-in-the-first-month'),
  real('protonvpn.com', 'Its help page says: “Send the requested BTC payment to the BTC address shown.”',
    'https://protonvpn.com/support/vpn-bitcoin-payments'),
  real('cloudzy.com', 'Its page says: “Send ETH to the invoice address, get a Linux VPS.”',
    'https://cloudzy.com/ethereum-vps/'),
  real('bitrefill.com', 'Its help center says each purchase “generates a new payment address”.',
    'https://help.bitrefill.com/hc/en-us/articles/4406025275666-Can-I-pay-to-the-same-address-for-different-purchases'),
  real('bitlaunch.io', 'Its blog says checkout shows a QR code, the amount and “the address to send it to.”',
    'https://bitlaunch.io/blog/get-a-windows-vps-with-bitcoin/'),
  real('silent.link', 'Its FAQ says to scan the QR code or “copy the payment address or Lightning invoice”.',
    'https://silent.link/faq'),
  real('racknerd.com', 'Its blog says to scan the QR code or “copy the wallet address and amount”.',
    'https://blog.racknerd.com/racknerd-expands-cryptocurrency-payment-options-with-coinify-integration/'),
  real('servermania.com', 'Its guide says to scan the QR code or send Bitcoin “to the address below”.',
    'https://servermania.com/kb/articles/bitcoin-payment-walk-through'),
  real('hawkhost.com', 'Its help page says you are “presented with the wallet address and QR code to scan”.',
    'https://www.hawkhost.com/kb/billing/how-do-i-pay-my-invoice-with-cryptocurrency/'),
  real('underhost.com', 'Its docs say Bitcoin payment shows “A unique wallet address and the exact amount due”.',
    'https://docs.underhost.com/article/bitcoin-payment/'),
  real('alexhost.com', 'Its FAQ says “A payment address and QR code will be displayed” for crypto.',
    'https://alexhost.com/faq/what-pyment-methods-do-we-accept-for-hosting-services/'),
  real('hostsailor.com', 'Its how-to says the CoinGate page shows “A unique wallet address for your transaction”.',
    'https://hostsailor.com/how-to-pay-with-cryptocurrencies'),
  real('monovm.com', 'Its blog says to “send the exact invoice amount to the wallet address”.',
    'https://monovm.com/blog/pay-vps-with-nowpayments/'),
  real('hostzealot.com', 'Its blog says you can “copy the address and bitcoin amount to send”.',
    'https://www.hostzealot.com/blog/news/we-accept-bitcoin'),
  real('hostwinds.com', 'Its docs say stablecoins are paid through Stripe, which “may provide a direct deposit address or QR code”.',
    'https://www.hostwinds.com/product-docs/billing/managing-cryptocurrency-payments'),
].filter(Boolean);

// The panel's second line under "Today", and its right column.
export const CHECKED = 'Checked 7 Nov 2026. Not a Sitebound customer.';
export const WITH_SITEBOUND = (domain) => [
  'No address on the page.',
  'Touch ID confirms the site and amount.',
  `It would pay only the wallet ${domain} registers. Buyers need only USDT.`,
];
