// The one list the orbit and the detail panel are drawn from. Add a site here and nothing else.
//
//   domain  what the chip shows, and the panel title
//   kind    'real'  a business that takes crypto today (not a Sitebound customer): its chip opens the detail panel
//           'ours'  a Sitebound example: its chip opens the setup for that site
//   what    five words on what the site is
//   today   how the site takes crypto now, one or two plain sentences (the left column of the panel)
//   proof   a link that shows it (a page or a screenshot), https only. Empty: the panel shows no link.
//   logo    a file under web/landing/logos/, for example 'logos/bitrefill.com.svg'. Empty, or if the file is missing,
//           the chip keeps a letter mark. Never a third-party URL: a hotlinked icon tells that host who visited.
//   origin  only when it is not https://<domain> (the local demo shop)
//
// Real sites were checked on 7 Nov 2026 to show a deposit address at checkout. `proof` links and the exact wording of
// `today` are still to be filled from the verified notes.
const demo = window.SITEBOUND?.demoShop;
const host = (o) => { try { return new URL(o).host; } catch { return o; } };

export const SITES = [
  demo && { domain: host(demo), origin: demo, kind: 'ours', what: 'The Sitebound demo shop', today: '', proof: '', logo: '' },
  { domain: '0xmujahid.xyz', kind: 'ours', what: 'Portfolio with a coffee button', today: '', proof: '', logo: '' },
  { domain: 'bitrefill.com', kind: 'real', what: 'Gift cards and top-ups', today: 'Shows a deposit address to copy at checkout.', proof: '', logo: '' },
  { domain: 'protonvpn.com', kind: 'real', what: 'Privacy VPN', today: 'Shows a deposit address to copy at checkout.', proof: '', logo: '' },
  { domain: 'cloudzy.com', kind: 'real', what: 'Cloud servers', today: 'Shows a deposit address to copy at checkout.', proof: '', logo: '' },
  { domain: 'surfercloud.com', kind: 'real', what: 'Cloud servers', today: 'Shows a deposit address to copy at checkout.', proof: '', logo: '' },
  { domain: 'bitlaunch.io', kind: 'real', what: 'Cloud servers', today: 'Shows a deposit address to copy at checkout.', proof: '', logo: '' },
].filter(Boolean);

// The right column of the panel, the same for every site: what changes with Sitebound on Whitechain.
export const WITH_SITEBOUND = [
  'No address on the page to swap.',
  'One passkey touch confirms site and amount.',
  'The contract pays only the site\u2019s wallet.',
];

// The "Try it" panel opened from the hero links.
export const TRY = {
  eyebrow: 'Try it',
  title: 'Buy the builder a coffee',
  text: 'Pay 3 USDT on a real site. The checkout shows the site and the amount, and one passkey touch pays. Whitechain Sepolia testnet.',
  cta: 'Open 0xmujahid.xyz',
  href: 'https://0xmujahid.xyz/#coffee',
};
