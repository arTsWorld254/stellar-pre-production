#!/usr/bin/env bash
# Deploys Morianah Works to Stellar TESTNET and runs a smoke test end to end.
# Prereqs (one-time):  rustup target add wasm32v1-none
#                      cargo install --locked stellar-cli
set -euo pipefail

NET=testnet
ADMIN_ROYALTY_BPS=${ADMIN_ROYALTY_BPS:-1000}   # 10 % to the artist on resale

echo "▶ building wasm"
stellar contract build --package morianah-works
WASM=target/wasm32v1-none/release/morianah_works.wasm

echo "▶ creating + funding testnet identities (admin, verifier, artist)"
for who in admin verifier artist; do
  stellar keys address "$who" >/dev/null 2>&1 || stellar keys generate "$who" --network $NET --fund
done
ADMIN=$(stellar keys address admin); VERIFIER=$(stellar keys address verifier); ARTIST=$(stellar keys address artist)

echo "▶ deploying"
CONTRACT=$(stellar contract deploy --wasm "$WASM" --source admin --network $NET -- \
  --admin "$ADMIN" --name "Morianah Works" --symbol MORI --base_uri "ipfs://" --artist_royalty_bps "$ADMIN_ROYALTY_BPS")
echo "   contract: $CONTRACT"
echo "$CONTRACT" > .contract-id.$NET

echo "▶ admin appoints a verifier"
stellar contract invoke --id "$CONTRACT" --source admin --network $NET -- \
  grant_role --account "$VERIFIER" --role verifier --caller "$ADMIN"

echo "▶ verifier approves an artist"
stellar contract invoke --id "$CONTRACT" --source verifier --network $NET -- \
  grant_role --account "$ARTIST" --role artist --caller "$VERIFIER"

echo "▶ artist mints a work (collection 1, sample CID + hash)"
HASH=$(printf 'morianah-sample' | sha256sum | cut -c1-64)
TOKEN=$(stellar contract invoke --id "$CONTRACT" --source artist --network $NET -- \
  mint_work --artist "$ARTIST" --collection 1 --cid "bafybeigdyrsample" --sha256 "$HASH")
echo "   minted token id: $TOKEN"

echo "▶ reading it back"
stellar contract invoke --id "$CONTRACT" --source admin --network $NET -- work --token_id "$TOKEN"
stellar contract invoke --id "$CONTRACT" --source admin --network $NET -- royalty_info --token_id "$TOKEN" --sale_price 10000

echo "✔ done. Explorer: https://stellar.expert/explorer/testnet/contract/$CONTRACT"
