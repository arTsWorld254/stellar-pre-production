# Deploys Morianah Works to Stellar with a WALLET address as the contract admin, from the first second.
# Nothing else is granted and nothing is minted: the admin wallet appoints verifiers from Studio.
#
#   .\deploy-with-wallet.ps1 -Admin GXXXX...                 (testnet)
#   .\deploy-with-wallet.ps1 -Admin GXXXX... -Net mainnet    (mainnet: the deployer key below must hold real XLM)
#
# Prereqs (one-time):  rustup (with the Visual Studio C++ build tools it offers to install)
#                      rustup target add wasm32v1-none
#                      winget install --id Stellar.StellarCLI
param(
  [Parameter(Mandatory = $true)][string]$Admin,     # G… public address of the wallet that will own the contract
  [string]$Net = "testnet",
  [string]$RoyaltyBps = "1000"                       # 10 % to the artist on resale (max 5000)
)
$ErrorActionPreference = "Stop"
if ($Admin -notmatch '^G[A-Z2-7]{55}$') { throw "-Admin must be a Stellar public address (G…, 56 characters)" }

Write-Host "> building wasm (first time takes a few minutes)"
stellar contract build --package morianah-works
$WASM = "target/wasm32v1-none/release/morianah_works.wasm"
if (-not (Test-Path $WASM)) { throw "wasm not found at $WASM" }

# The deployer key only pays the deploy fee. It holds no role on the contract.
Write-Host "> deployer key (pays the fee only)"
$exists = $false
try { $null = stellar keys address deployer 2>$null; if ($LASTEXITCODE -eq 0) { $exists = $true } } catch { }
if (-not $exists) {
  if ($Net -eq "testnet") { stellar keys generate deployer --network $Net --fund }
  else { throw "create a funded 'deployer' identity first:  stellar keys add deployer   (paste its secret key), then fund it with ~5 XLM" }
  if ($LASTEXITCODE -ne 0) { throw "could not create deployer identity" }
}
Write-Host "   deployer $((stellar keys address deployer).Trim())"

Write-Host "> deploying with admin = $Admin"
$CONTRACT = (stellar contract deploy --wasm $WASM --source deployer --network $Net -- `
  --admin $Admin --name "Morianah Works" --symbol MORI --base_uri "ipfs://" --artist_royalty_bps $RoyaltyBps).Trim()
Write-Host "   contract: $CONTRACT"
Set-Content -Path ".contract-id.$Net" -Value $CONTRACT

Write-Host "> reading back"
stellar contract invoke --id $CONTRACT --source deployer --network $Net -- get_admin
stellar contract invoke --id $CONTRACT --source deployer --network $Net -- artist_royalty_bps

Write-Host ""
Write-Host "DONE."
Write-Host "  Contract id : $CONTRACT        -> put this in morianah-api/wrangler.toml  CONTRACT_ID"
Write-Host "  Admin wallet: $Admin  -> put this in morianah-api/wrangler.toml  ADMIN_ADDRESSES"
Write-Host "  Explorer    : https://stellar.expert/explorer/$Net/contract/$CONTRACT"
