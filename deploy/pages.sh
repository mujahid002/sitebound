#!/bin/sh
# Deploys the frame host (landing, frame, button, onboard, dashboard) and the demo shop to Cloudflare Pages.
# Run from anywhere. Needs `wrangler login`; the env vars are unset so a token for another account is never used.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
wr() { env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID -u CF_API_TOKEN npx wrangler "$@"; }

mkdir "$tmp/pay" "$tmp/demo"
rsync -a --exclude dev --exclude demo-shop --exclude attack "$root/web/" "$tmp/pay/"
printf '/ /landing/ 302\n' > "$tmp/pay/_redirects"
rsync -a "$root/web/demo-shop/" "$tmp/demo/"
cp "$root/web/config.js" "$tmp/demo/"
mkdir -p "$tmp/demo/attack" && rsync -a "$root/web/attack/" "$tmp/demo/attack/"

cd /tmp
wr pages deploy "$tmp/pay" --project-name sitebound-pay --branch main --commit-dirty=true
wr pages deploy "$tmp/demo" --project-name sitebound-demo --branch main --commit-dirty=true
rm -rf "$tmp"
