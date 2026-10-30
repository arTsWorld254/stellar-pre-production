# Morianah contracts (Stellar / Soroban)

Step 1 of the build path: **`morianah-works`** — the on-chain registry of vetted artworks.

Built on OpenZeppelin's audited Stellar library (v0.8.0, soroban-sdk 28). The only bespoke
logic is role wiring and a per-work provenance record; no custom token maths.

## What it enforces
| Rule | How |
| --- | --- |
| Only vetted artists can mint | `#[only_role(artist, "artist")]` — the artist must hold the role **and sign** |
| Verifiers approve/remove artists, nothing more | `"verifier"` is the *admin role* of `"artist"`; library `grant_role`/`revoke_role` enforce it |
| Only the admin (multisig) creates verifiers, pauses, sets royalty terms | `#[only_admin]` |
| Every work carries provenance | `Work { artist, collection, cid, sha256, minted_at }` written at mint, immutable |
| The same file can't be minted twice | `sha256 → token_id` index |
| Artists earn on resale | ERC-2981-style `royalty_info`; per-token royalty set to the artist at mint |
| Pause stops minting, never collectors' transfers | `#[when_not_paused]` on `mint_work` only |
| Admin handover is two-step | library `transfer_admin_role` + `accept_admin_transfer` |

## Test (no network needed)
```
cargo test -p morianah-works        # 25 tests
```

## Deploy to testnet (your machine)
Windows (PowerShell):
```
# one-time: install Rust from https://rustup.rs (accept the Visual Studio C++ build tools it offers)
rustup target add wasm32v1-none
winget install --id Stellar.StellarCLI
.\deploy-testnet.ps1               # builds, deploys, appoints verifier, approves artist, mints, reads back
```
macOS / Linux:
```
rustup target add wasm32v1-none
cargo install --locked stellar-cli   # or: curl -fsSL https://github.com/stellar/stellar-cli/raw/main/install.sh | sh
./deploy-testnet.sh
```

## Public interface (selected)
- `mint_work(artist, collection, cid, sha256) -> token_id`
- `work(token_id) -> Work`, `token_by_hash(sha256) -> Option<token_id>`
- `grant_role / revoke_role(account, role, caller)`, `is_artist`, `is_verifier`
- `pause / unpause(caller)`, `paused()`
- `set_artist_royalty_bps(bps)` (admin, future mints only), `royalty_info(token_id, price)`
- standard NFT: `owner_of`, `balance`, `transfer`, `approve`, `token_uri`, `name`, `symbol`

## Error codes
`100` royalty too high · `101` empty CID/hash · `102` no such work · `103` duplicate file ·
library: `2000` unauthorized · `201` not the owner · `1000` minting paused

## Not in this contract (by design)
Sales (step 5, separate marketplace contract) · profiles and the vetting queue (Cloudflare D1) ·
upgradeability (v1 is immutable; redeploy).
