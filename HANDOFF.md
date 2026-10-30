# Morianah platform — handoff

Three folders, one sequence. Everything is free-tier and has been run end to end on testnet.

| Folder | What | Verified |
| --- | --- | --- |
| `morianah-contracts/` | Soroban contract `morianah-works` (Rust): roles admin → verifier → artist, `mint_work` with SHA-256 + IPFS CID, per-token artist royalty, pause, two-step admin transfer. OpenZeppelin stellar-contracts 0.8. | 25 contract tests; deployed on testnet |
| `morianah-api/` | Cloudflare Worker + D1 + R2 (Hono/TypeScript): profiles (artist / verifier / curator / collector), SEP-10 wallet login, uploads with vetting queue, IPFS pinning, mint prepare/confirm, hourly chain reconcile, **Studio** web client with Admin panel. The API holds no signing key — every on-chain action is signed in the user's wallet. | 71 HTTP tests (`test/`) |
| `site/` | Landing site (morianahinc.com): Enter the platform → logo → Collections → 360° exhibition, plus a Studio entry pointing at the Worker. | Deployment 16 |

## Who signs what
- **Admin wallet** (the one you set at deploy): appoints verifiers, pauses minting, publishes collections, transfers admin. Also the "dashboard admin" (`ADMIN_ADDRESSES`) for the Studio Admin panel.
- **Verifier wallets**: approve artists (sign `grant_role(artist)`) and works.
- **Artist wallets**: upload, then sign `mint_work`. The artist's address is written into the token's royalty.
- The **deployer key** only pays the deploy fee and holds no role. The deploy *record* is immutable; the admin *role* is transferable (`transfer_admin_role` → `accept_admin_transfer`).

## Sequence (about an hour, Windows / PowerShell shown)

### 0. Tools (one-time)
rustup (accept the Visual Studio C++ build tools it offers) · `rustup target add wasm32v1-none` · `winget install --id Stellar.StellarCLI` · Node 20+ · VS Code · the Varial Wallet browser extension (formerly Freighter) on **Test Net**, funded with Friendbot.
Open a new terminal after installing. If PowerShell refuses scripts: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, then `Unblock-File .\deploy-with-wallet.ps1`.

### 1. Contract — admin = your wallet from the first second
```
cd morianah-contracts
.\deploy-with-wallet.ps1 -Admin G<your wallet address>
```
Prints the contract id (also saved to `.contract-id.testnet`). Nothing else is granted; no sample mint.
Optional local check first: `cargo test` (25 tests).

### 2. API on Cloudflare
```
cd morianah-api
npm install
npx wrangler login
npx wrangler d1 create morianah            # paste database_id into wrangler.toml (keep binding = "DB")
```
Edit `wrangler.toml`: `database_id`, `CONTRACT_ID` (from step 1), `ADMIN_ADDRESSES = "G<your wallet>"` (comma-separate for several).
Enable R2 once in the dashboard (Storage & databases → R2 → Enable; the free 10 GB needs a card on file but is not charged), then:
```
npx wrangler r2 bucket create morianah-images
npx wrangler d1 migrations apply morianah --remote      # 3 files: 0001, 0002, 0003 — never dev-seed.sql
stellar keys generate signer ; stellar keys secret signer     # SEP-10 server signing key; keep the S… private
npx wrangler secret put SERVER_SIGNING_SECRET           # paste the S… at the prompt (right-click pastes)
npx wrangler secret put PINATA_JWT                      # pinata.cloud → API Keys (free); optional at first
npx wrangler deploy                                     # prints https://morianah-api.<account>.workers.dev
```
Open `<that URL>/studio`, sign in with the admin wallet → Admin panel.

### 3. First run on the live Studio
1. Admin · collections → create `1 / if-flowers-went-to-war / If Flowers Went to War` → **Publish**.
2. Admin · verifiers → appoint a verifier (can be yourself) → **Sign on-chain verifier role**.
3. As an artist wallet: profile → Apply. As verifier: approve → **Sign on-chain artist role**.
4. Artist uploads → verifier approves → artist **Mint on Stellar**. Token id appears; check on stellar.expert.

### 4. Landing site
In `site/collections/index.html`, set `STUDIO_URL` to the Worker URL (or `app.morianahinc.art` once attached to the Worker under Custom Domains). Zip `site/` and upload as the next deployment, same as before.

## Running locally (optional)
```
cd morianah-api
npx wrangler d1 migrations apply morianah --local
npx wrangler d1 execute morianah --local --file dev-seed.sql     # test sessions, LOCAL ONLY
npx wrangler dev                                                # http://localhost:8787
node test/e2e.mjs ; node test/auth.mjs ; node test/mint.mjs ; node test/admin.mjs   # 36 / 13 / 17 / 5
```
`.dev.vars` holds local-only settings (`CHAIN_FAKE=1` swaps the chain for an in-memory fake; never set in production).

## Mainnet later (not yet)
Deploy fresh with `-Net mainnet` and a funded deployer key; admin = a multisig or a dedicated hardware wallet; set `NETWORK_PASSPHRASE`, `RPC_URL`, `CONTRACT_ID` in `wrangler.toml`; audit first; the step-5 marketplace contract (USDC sales with royalty split) comes before any selling.
