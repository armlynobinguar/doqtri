#!/usr/bin/env bash
# Deploy TemplateMarket and allow its tokens (progress/004).
#
#   market/deploy.sh <testnet|mainnet> <source-identity> <admin> <treasury>
#
# <source-identity> is a stellar-cli identity that pays for the upload and
# deploy. <admin> and <treasury> are addresses (or identities): on mainnet the
# treasury should be a multisig account with a USDC trustline, or USDC sales
# fail on the treasury transfer. The split is fixed at 85/5/10 here; change it
# later with `set_fees`.
#
# Mainnet costs real XLM (upload simulated at ~19 XLM on 2026-10-13, typically
# charged ~15% under the simulation). Run with DRY_RUN=1 to build and print
# the commands without sending anything.
set -euo pipefail

network="${1:?network: testnet or mainnet}"
source="${2:?source identity}"
admin="${3:?admin address}"
treasury="${4:?treasury address}"

case "$network" in
  testnet) usdc_issuer="GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" ;;
  mainnet) usdc_issuer="GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" ;;
  *) echo "network must be testnet or mainnet" >&2; exit 2 ;;
esac

run() {
  echo "+ $*" >&2
  if [ "${DRY_RUN:-0}" = "1" ]; then return 0; fi
  "$@"
}

root="$(cd "$(dirname "$0")/.." && pwd)"
wasm="$root/target/wasm32v1-none/release/doqtri_market.wasm"

(cd "$root/market" && stellar contract build)
echo "wasm sha256: $(shasum -a 256 "$wasm" | cut -d' ' -f1)" >&2

xlm="$(stellar contract id asset --asset native --network "$network")"
usdc="$(stellar contract id asset --asset "USDC:$usdc_issuer" --network "$network")"

if [ "${DRY_RUN:-0}" = "1" ]; then
  market="<new contract id>"
  run stellar contract deploy --wasm "$wasm" --source "$source" --network "$network" -- \
    --admin "$admin" --treasury "$treasury" --creator_bps 8500 --parent_bps 500 --treasury_bps 1000
else
  market="$(run stellar contract deploy --wasm "$wasm" --source "$source" --network "$network" -- \
    --admin "$admin" --treasury "$treasury" --creator_bps 8500 --parent_bps 500 --treasury_bps 1000)"
fi

# set_token needs the admin's signature: run these as the admin.
for token in "$xlm" "$usdc"; do
  run stellar contract invoke --id "$market" --source "$admin" --network "$network" -- \
    set_token --token "$token" --allowed true
done

cat >&2 <<EOF

TemplateMarket on $network: $market
  XLM  $xlm
  USDC $usdc
Next:
  - NEXT_PUBLIC_MARKET_CONTRACT_ID=$market in the app's environment
  - keep the code entry alive: stellar contract extend --wasm "$wasm" --network $network --ledgers-to-extend <n> --source $source
EOF
