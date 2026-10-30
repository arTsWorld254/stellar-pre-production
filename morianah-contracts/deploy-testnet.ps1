# Deploys Morianah Works to Stellar TESTNET and runs a smoke test end to end. (Windows / PowerShell)
# Prereqs (one-time):  rustup (with the Visual Studio C++ build tools it offers to install)
#                      rustup target add wasm32v1-none
#                      winget install --id Stellar.StellarCLI
$ErrorActionPreference = "Stop"
$NET = "testnet"
$ROYALTY_BPS = if ($env:ARTIST_ROYALTY_BPS) { $env:ARTIST_ROYALTY_BPS } else { "1000" }   # 10 % to the artist on resale

Write-Host "> building wasm (first time takes a few minutes)"
stellar contract build --package morianah-works
$WASM = "target/wasm32v1-none/release/morianah_works.wasm"
if (-not (Test-Path $WASM)) { throw "wasm not found at $WASM" }

Write-Host "> creating + funding testnet identities (admin, verifier, artist)"
foreach ($who in @("admin", "verifier", "artist")) {
  $exists = $false
  try { $null = stellar keys address $who 2>$null; if ($LASTEXITCODE -eq 0) { $exists = $true } } catch { }
  if ($exists) { Write-Host "   $who already exists, keeping it" }
  else { stellar keys generate $who --network $NET --fund; if ($LASTEXITCODE -ne 0) { throw "could not create identity $who" } }
}
$ADMIN    = (stellar keys address admin).Trim()
$VERIFIER = (stellar keys address verifier).Trim()
$ARTIST   = (stellar keys address artist).Trim()
Write-Host "   admin    $ADMIN"
Write-Host "   verifier $VERIFIER"
Write-Host "   artist   $ARTIST"

Write-Host "> deploying"
$CONTRACT = (stellar contract deploy --wasm $WASM --source admin --network $NET -- `
  --admin $ADMIN --name "Morianah Works" --symbol MORI --base_uri "ipfs://" --artist_royalty_bps $ROYALTY_BPS).Trim()
Write-Host "   contract: $CONTRACT"
Set-Content -Path ".contract-id.$NET" -Value $CONTRACT

Write-Host "> admin appoints a verifier"
stellar contract invoke --id $CONTRACT --source admin --network $NET -- `
  grant_role --account $VERIFIER --role verifier --caller $ADMIN | Out-Null

Write-Host "> verifier approves an artist"
stellar contract invoke --id $CONTRACT --source verifier --network $NET -- `
  grant_role --account $ARTIST --role artist --caller $VERIFIER | Out-Null

Write-Host "> artist mints a work (collection 1, sample CID + hash)"
$sha = [System.Security.Cryptography.SHA256]::Create()
$HASH = ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("morianah-sample")) | ForEach-Object { $_.ToString("x2") }) -join ""
$TOKEN = (stellar contract invoke --id $CONTRACT --source artist --network $NET -- `
  mint_work --artist $ARTIST --collection 1 --cid "bafybeigdyrsample" --sha256 $HASH).Trim()
Write-Host "   minted token id: $TOKEN"

Write-Host "> reading it back"
stellar contract invoke --id $CONTRACT --source admin --network $NET -- work --token_id $TOKEN
stellar contract invoke --id $CONTRACT --source admin --network $NET -- royalty_info --token_id $TOKEN --sale_price 10000

Write-Host ""
Write-Host "DONE. Explorer: https://stellar.expert/explorer/testnet/contract/$CONTRACT"
