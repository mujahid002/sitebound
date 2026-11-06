#!/bin/sh
# Check that the Sitebound contract on Whitechain Sepolia (chain 1874) is the code in this repo.
# Rebuilds from source, fetches the deployed runtime code, zeroes the immutable slots in both
# (the constructor args are baked into them: SiteboundV2 has token, rpIdHash, delay, maxRelayerFee and
# guardian), and compares. Needs only forge and cast.
#   RPC_URL   optional, defaults to the public Whitechain testnet RPC (never printed)
#   ADDRESS   the deployment to check. SiteboundV2: set after the V2 deploy (placeholder below).
#   CONTRACT  optional, SiteboundV2 by default. The v1 deployment the live frame still uses:
#             CONTRACT=Sitebound ADDRESS=0x43bb27f7079c76D6F0Fa4b4e6d69843e0457DF73 sh scripts/verify.sh
set -eu

CONTRACT=${CONTRACT:-SiteboundV2}
ADDRESS=${ADDRESS:-0x64117398C837a8708a816818b31C36Df5a968596} # SiteboundV2 on Whitechain Sepolia
RPC=${RPC_URL:-https://rpc.testnet.whitechain.io}
cd "$(dirname "$0")/.."

die() { echo "error: $*" >&2; exit 2; }
[ "$ADDRESS" != 0x0000000000000000000000000000000000000000 ] || die "set ADDRESS: SiteboundV2 is not deployed yet"

# 1. Rebuild with foundry.toml settings (solc 0.8.28, via_ir, optimizer 200, cancun).
forge build --force >/dev/null 2>&1 || die "forge build failed (run it directly to see why)"

# 2. Local runtime bytecode, and the immutable byte ranges from the build artifact.
local_hex=$(forge inspect "$CONTRACT" deployedBytecode 2>/dev/null) || die "forge inspect failed"
local_hex=${local_hex#0x}
artifact=out/$CONTRACT.sol/$CONTRACT.json
[ -f "$artifact" ] || die "missing $artifact"
# One line of JSON; take the pairs after "deployedBytecode" (the creation bytecode has none).
ranges=$(sed 's/.*"deployedBytecode"://' "$artifact" \
  | grep -o '{"start":[0-9]*,"length":[0-9]*}' \
  | sed 's/[^0-9,]//g' | sort -t, -k1,1n)
[ -n "$ranges" ] || die "no immutableReferences in the artifact"

# 3. Deployed runtime bytecode. Errors are swallowed on purpose: they can echo the RPC URL.
chain_hex=$(cast code "$ADDRESS" --rpc-url "$RPC" 2>/dev/null) || die "could not fetch code from the RPC"
chain_hex=${chain_hex#0x}
[ -n "$chain_hex" ] || die "no code at $ADDRESS"

# mask HEX: zero every immutable range (offsets are bytes, hex chars are 2 per byte).
mask() {
  _hex=$1; _out=; _pos=0
  for r in $ranges; do
    _s=${r%,*}; _l=${r#*,}
    _out=$_out$(printf %s "$_hex" | cut -c$((_pos * 2 + 1))-$((_s * 2)))
    _out=$_out$(printf '%0*d' $((_l * 2)) 0)
    _pos=$((_s + _l))
  done
  _out=$_out$(printf %s "$_hex" | cut -c$((_pos * 2 + 1))-)
  printf %s "$_out"
}

local_masked=$(mask "$local_hex")
chain_masked=$(mask "$chain_hex")
local_hash=$(cast keccak "0x$local_masked")
chain_hash=$(cast keccak "0x$chain_masked")

echo "address         $ADDRESS"
echo "runtime bytes   local $((${#local_hex} / 2))  chain $((${#chain_hex} / 2))"
echo "masked hash     local $local_hash"
echo "masked hash     chain $chain_hash"
if [ "$local_hash" = "$chain_hash" ]; then
  echo "MATCH $chain_hash"
  exit 0
fi
echo "MISMATCH local $local_hash chain $chain_hash"
exit 1
