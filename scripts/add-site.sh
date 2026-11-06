#!/bin/sh
# Adds a website to Sitebound without DNS (demo/admin only), then registers it on chain through the relayer.
#
#   sh scripts/add-site.sh https://shop.example 0xPayoutAddress
#
# Needs ADMIN_TOKEN (the relayer's ADMIN_TOKEN secret) in the environment or in .env at the repo root.
# RELAYER_URL defaults to the live relayer. Prints the transaction hash and an explorer link, never the token.
set -eu

die() { echo "add-site: $*" >&2; exit 1; }

site=${1:-}
payout=${2:-}
printf '%s' "$site" | grep -Eq '^https://[A-Za-z0-9.-]+/?$' ||
  die "usage: $0 https://<site> 0x<payout address> (an https origin: no port, path or other characters)"
printf '%s' "$payout" | grep -Eq '^0x[0-9a-fA-F]{40}$' || die "payout must be a 0x address with 40 hex digits"

root=$(cd "$(dirname "$0")/.." && pwd)
# Read only the two keys we need from .env; never source it.
fromenv() { [ -f "$root/.env" ] && sed -n "s/^$1=//p" "$root/.env" | tail -n 1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
ADMIN_TOKEN=${ADMIN_TOKEN:-$(fromenv ADMIN_TOKEN || true)}
RELAYER_URL=${RELAYER_URL:-$(fromenv RELAYER_URL || true)}
RELAYER_URL=${RELAYER_URL:-https://sitebound-relayer.sitebound-relayer.workers.dev}
EXPLORER=${EXPLORER:-https://explorer.testnet.whitechain.io}
[ -n "$ADMIN_TOKEN" ] || die "set ADMIN_TOKEN in the environment or in .env"

# The token goes to curl on stdin (-H @-), so it is not in the process list.
post() {
  printf 'Authorization: Bearer %s\n' "$ADMIN_TOKEN" |
    curl -sS -H @- -H 'content-type: application/json' -X POST --data "$2" "$RELAYER_URL$1"
}
field() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p"; }

out=$(post /admin/sites "{\"site\":\"$site\",\"payout\":\"$payout\"}")
canon=$(printf '%s' "$out" | field site)
[ -n "$canon" ] || die "admin API: $(printf '%s' "$out" | field error)"

# /register needs the exact origin the admin API stored. A fresh KV entry can take up to a minute to be seen
# everywhere, so retry while the relayer still reads the old payout.
i=0
while :; do
  out=$(post /register "{\"site\":\"$canon\",\"payout\":\"$payout\"}")
  err=$(printf '%s' "$out" | field error)
  case "$err" in *TXT*|*"does not match"*) [ $i -lt 6 ] || break; i=$((i + 1)); sleep 10; continue;; esac
  break
done
[ -z "$err" ] || die "register: $err"

tx=$(printf '%s' "$out" | field txHash)
if [ -n "$tx" ]; then
  echo "$tx"
  echo "$EXPLORER/tx/$tx"
  case "$out" in *'"pending":true'*) echo "$canon was already registered: the new payout goes live after the contract's delay.";; esac
else
  echo "$canon is already registered to $payout (no transaction needed)."
fi
