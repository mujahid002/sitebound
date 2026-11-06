#!/bin/sh
# Points the web config, the relayer and the landing page at a newly deployed contract.
# Usage: deploy/migrate-v2.sh 0xNewAddress
# Docs, scripts/verify.sh and web/verify/expected.json are updated separately (they carry the build hash).
set -e
new=$1
old=0x43bb27f7079c76D6F0Fa4b4e6d69843e0457DF73
case "$new" in 0x[0-9a-fA-F][0-9a-fA-F]*) ;; *) echo "usage: $0 0xAddress" >&2; exit 1;; esac
[ ${#new} -eq 42 ] || { echo "address must be 42 characters" >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
for f in web/config.js worker/wrangler.toml web/landing/index.html; do
  sed -i.bak "s/$old/$new/g" "$root/$f" && rm -f "$root/$f.bak"
  echo "updated $f: $(grep -c "$new" "$root/$f") match(es)"
done
