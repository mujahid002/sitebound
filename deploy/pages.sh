#!/bin/sh
# Deploys the frame host (landing, frame, button, onboard, dashboard) and the demo shop to Cloudflare Pages.
# Run from anywhere. Needs `wrangler login`; the env vars are unset so a token for another account is never used.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
wr() { env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID -u CF_API_TOKEN npx wrangler "$@"; }

mkdir "$tmp/pay" "$tmp/demo" "$tmp/phish"
rsync -a --exclude dev --exclude demo-shop --exclude attack --exclude landing "$root/web/" "$tmp/pay/"
# The landing page is the site root: copy it up one level and turn its ../ paths into root paths.
rsync -a "$root/web/landing/" "$tmp/pay/"
sed -i.bak -e 's#\.\./#/#g' -e 's#href="\./"#href="/"#' "$tmp/pay/index.html" "$tmp/pay/main.js" "$tmp/pay/kit.js"
rm -f "$tmp"/pay/*.bak
printf '/landing / 301\n/landing/ / 301\n' > "$tmp/pay/_redirects"
rsync -a "$root/web/demo-shop/" "$tmp/demo/"
cp "$root/web/config.js" "$tmp/demo/"
mkdir -p "$tmp/demo/demo-shop" && cp "$root/web/demo-shop/shop.css" "$tmp/demo/demo-shop/"
# The demo shop's payment check: ethers and the merchant helper, at the paths its ../ links resolve to.
mkdir -p "$tmp/demo/vendor" "$tmp/demo/merchant"
cp "$root/web/vendor/ethers-6.17.0.umd.min.js" "$tmp/demo/vendor/"
cp "$root/web/merchant/sitebound-merchant.mjs" "$tmp/demo/merchant/"
# The fake site lives only on the phish origin: on the real, registered origin it would contradict its own copy.
mkdir -p "$tmp/demo/attack" && rsync -a --exclude phish.html "$root/web/attack/" "$tmp/demo/attack/"
mkdir -p "$tmp/phish/attack" "$tmp/phish/demo-shop"
# Only the fake page and what it loads; its root opens the fake page instead of a 404.
rsync -a --exclude index.html --exclude classic.html --exclude sitebound.html "$root/web/attack/" "$tmp/phish/attack/"
printf '/ /attack/phish 302\n' > "$tmp/phish/_redirects"
cp "$root/web/config.js" "$tmp/phish/"
cp "$root/web/demo-shop/shop.css" "$tmp/phish/demo-shop/"

cd /tmp
wr pages deploy "$tmp/pay" --project-name sitebound-pay --branch main --commit-dirty=true
wr pages deploy "$tmp/demo" --project-name sitebound-demo --branch main --commit-dirty=true
wr pages deploy "$tmp/phish" --project-name sitebound-phish --branch main --commit-dirty=true
rm -rf "$tmp"
