# Morianah API (Cloudflare Workers + D1 + R2)

Steps 2, 3 and 4 of the build path: profiles for the four personas, artist applications, artwork
uploads, and the verifier vetting queue. Ownership and sales are **not** here — they live on
Stellar (`morianah-contracts`). This service is the workflow layer that feeds the chain.

## What it enforces (36 end-to-end tests)
| Rule | Where |
| --- | --- |
| Every protected call needs a session; suspended accounts are refused | `auth` middleware |
| Only admins (`ADMIN_ADDRESSES`) appoint verifiers and create collections | `POST /api/admin/verifiers`, `/api/admin/collections` |
| Artists must be *approved* before they can upload | `artist_applications.status = 'approved'` |
| Verifiers review applications and works; never their own | `/api/verify/*` |
| Uploads: jpeg/png/webp only, size-capped, Turnstile-checked, 20/day/artist | `POST /api/uploads` |
| The same file can't be submitted twice, by anyone | `submissions.sha256 UNIQUE` |
| Pending/rejected images are private to the artist and reviewers | `GET /api/images/:key` |
| Only approved or minted works are public | `GET /api/works` |
| Every decision is written to an audit log | `audit_log` |

The SHA-256 computed here is the value written on chain at mint (`mint_work(..., sha256)`),
so a file can always be checked against the vetted original.

## Login (step 3) — SEP-10, 13 end-to-end tests
A wallet proves it controls a `G…` address by signing a server-issued challenge; the server
verifies both signatures with the Stellar SDK's audited SEP-10 helpers and issues a session.

| Rule | Where |
| --- | --- |
| Challenge is a sequence-0 transaction: it can never be submitted or cost a fee | `WebAuth.buildChallengeTx` |
| Server signature, time bounds, home domain and web-auth domain are all checked | `WebAuth.readChallengeTx` |
| The client signature must be valid for the account the challenge was issued to | `WebAuth.verifyChallengeTxSigners` + `auth_challenges.account` |
| Each challenge is redeemable once, within 5 minutes | `auth_challenges` keyed on the tx hash |
| Sessions last 24 h; logout deletes them; an hourly cron sweeps expired rows | `sessions`, `[triggers]` |

Routes: `GET /auth/info` · `GET /auth/challenge?account=G…` · `POST /auth/verify {transaction}` · `POST /auth/logout`.
`public/login.html` is a working reference client for Varial Wallet (formerly Freighter; same SDF extension), served by the Worker at `/login`. It bundles `@stellar/freighter-api` 6.0.1 as `public/freighter-api.min.js`.

**Passkey smart wallets (`C…` addresses) use SEP-45, not SEP-10.** `GET /auth/challenge` already
recognises a contract address and returns 501 with that message. SEP-45 needs a deployed
web-auth contract and live RPC simulation to verify, so it is the first piece of step 3 that must
be finished on a machine with network access: Stellar's Anchor Platform ships a reference
implementation and a testnet web-auth contract (`CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX`).
The session table and everything downstream are already shared, so adding SEP-45 touches only `src/auth.ts`.

Secrets/vars: `SERVER_SIGNING_SECRET` (`wrangler secret put`), `HOME_DOMAIN`, `WEB_AUTH_DOMAIN`,
`NETWORK_PASSPHRASE`. Publish the signing public key as `SIGNING_KEY` in `/.well-known/stellar.toml`.

## Mint pipeline (step 4) — 17 end-to-end tests
Joins this API to the `morianah-works` contract. **The API holds no signing key**: artists sign
mints and verifiers sign role grants in their own wallet; the API prepares and then *reads the
chain* to confirm.

| Step | Who | What |
| --- | --- | --- |
| `POST /api/submissions/:id/prepare-mint` | artist | pins image + metadata JSON to IPFS (Pinata), stores `cid`, returns the exact `mint_work` arguments. Idempotent. |
| wallet signs `mint_work(artist, collection, cid, sha256)` | artist (browser) | `public/studio.html` builds, simulates and submits via Stellar RPC; Varial signs |
| `POST /api/submissions/:id/confirm-mint {tx_hash}` | artist | checks the tx succeeded and called *this* contract, then asks the contract `token_by_hash(sha256)` → `status='minted'`, `token_id` |
| hourly cron `reconcileChain` | — | any approved+pinned work the chain already has → minted; any approved artist whose on-chain role exists → `onchain_granted=1` |
| `POST /api/verify/artists/:address/sync` | verifier | reads `has_role(address,"artist")` from the chain |
| wallet signs `grant_role(artist,"artist",verifier)` | verifier (browser) | the only way an artist gets minting rights |

`GET /api/chain/info` tells the browser the contract id, RPC URL and network.
`public/studio.html` (served at `/studio`) is the reference client: sign in, create a profile,
apply, upload, review, **Mint on Stellar**, **Sign on-chain artist role**.

## Admin panel (step 4b) — 5 end-to-end tests
Shown in `/studio` only to wallets listed in `ADMIN_ADDRESSES`. No terminal needed to run the platform:

| Section | Does | Routes |
| --- | --- | --- |
| Contract | shows on-chain admin + paused state; **Accept on-chain admin**, **Pause / Unpause minting** (wallet signs) | `GET /api/admin/chain?verifiers=` |
| Verifiers | appoint (profile), **Sign on-chain verifier role** = `grant_role(addr,"verifier",admin)`, suspend | `POST /api/admin/verifiers`, `GET /api/admin/profiles?persona=verifier` |
| Collections | create (draft), publish / unpublish; artists only see *live* ones | `GET/POST /api/admin/collections`, `PATCH /api/admin/collections/:id` |
| People | every profile, suspend / reactivate | `GET /api/admin/profiles`, `POST /api/admin/profiles/:address/status` |
| Audit log | last 60 actions | `GET /api/admin/audit` |

**One-time on-chain handover.** `deploy-testnet.ps1` made a CLI key (`admin`) the contract admin. To let your
wallet run the contract from the panel, hand the admin role to it (two-step, so a typo cannot lose the contract).
From `morianah-contracts`, PowerShell:
```
$L = (Invoke-RestMethod https://horizon-testnet.stellar.org).history_latest_ledger + 100000
stellar contract invoke --id CD7L4WM2QJT2APPB74UL6P6KKWSUHJ6FNYMJEDS45O2WQG5JGEI5VXHX --source admin --network testnet -- transfer_admin_role --new_admin <YOUR_WALLET_G…> --live_until_ledger $L
```
then in Studio → Admin · contract → **Accept on-chain admin** (your wallet signs `accept_admin_transfer`).
After that: appoint yourself (or anyone) as verifier and press **Sign on-chain verifier role**; verifiers can then
grant artists, and artists can mint.

Config: `CONTRACT_ID`, `RPC_URL`, `NETWORK_PASSPHRASE` in `wrangler.toml`; `PINATA_JWT` as a secret
(without it, dev placeholder CIDs are used and `/api/chain/info` reports `ipfs: dev-placeholder`).
`CHAIN_FAKE=1` (dev only, in `.dev.vars`) swaps the RPC reader for an in-memory fake with test
control routes `/api/_test/*`; never set it in production.

## Run locally
```
npm install
npx wrangler d1 migrations apply morianah --local
npx wrangler d1 execute morianah --local --file dev-seed.sql   # dev sessions
npx wrangler dev                       # http://localhost:8787
node test/e2e.mjs; node test/auth.mjs; node test/mint.mjs; node test/admin.mjs   # another terminal, one at a time (71 tests)
```
`.dev.vars` sets `ADMIN_ADDRESSES` for local runs.

## Deploy (free tier)
```
npx wrangler login
npx wrangler d1 create morianah        # paste the id into wrangler.toml
npx wrangler r2 bucket create morianah-images
npx wrangler d1 migrations apply morianah --remote
npx wrangler secret put SERVER_SIGNING_SECRET   # a fresh Stellar secret key (S…); keep it out of git
npx wrangler secret put PINATA_JWT              # from pinata.cloud → API Keys (free tier)
npx wrangler secret put TURNSTILE_SECRET        # optional until the form has Turnstile
npx wrangler deploy
```
Set `ADMIN_ADDRESSES` in `wrangler.toml` to the multisig signers' Stellar addresses.

## Routes
Public: `GET /api/health` · `/api/collections` · `/api/profiles/:address` · `/api/works` · `/api/images/:key`
Session: `GET /api/me` · `POST /api/profiles` · `PATCH /api/profiles/me`
Artist: `POST /api/artists/apply` · `GET /api/artists/me` · `POST /api/uploads` (multipart: image, title, description?, collection_id?, turnstile?) · `GET /api/submissions/mine` · `DELETE /api/submissions/:id`
Verifier: `GET /api/verify/artists?status=` · `POST /api/verify/artists/:address {decision, note}` · `GET /api/verify/submissions?status=` · `POST /api/verify/submissions/:id {decision, note}`
Admin: `POST /api/admin/verifiers` · `GET|POST /api/admin/collections` · `PATCH /api/admin/collections/:id` · `GET /api/admin/profiles` · `POST /api/admin/profiles/:address/status` · `GET /api/admin/chain` · `GET /api/admin/audit`

## Hand-offs to later steps
- **Step 3b (passkeys):** SEP-45 in `src/auth.ts` as above; then the dev-seed file goes away.
- **Step 5 (marketplace):** a second contract (list / buy in USDC with royalty split); this API mirrors listings and sales the same way it mirrors mints.
