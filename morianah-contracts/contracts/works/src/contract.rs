//! Morianah Works — the platform's registry of artworks on Stellar (Soroban).
//!
//! One contract holds every vetted artist's works as non-fungible tokens.
//! Built entirely from OpenZeppelin's audited Stellar library; the only
//! bespoke logic is (a) which roles may do what and (b) a small per-work
//! record (IPFS CID + SHA-256 + collection) written at mint.
//!
//! Roles
//! ------
//! * admin            — the platform multisig. Can pause, set royalty terms,
//!                      grant/revoke any role, and hand admin over (two-step).
//! * "verifier"       — may approve or remove artists. Verifier is the *admin
//!                      role* of "artist", so the library's own grant_role /
//!                      revoke_role enforce this; no custom auth code.
//! * "artist"         — may mint works. Granted only by a verifier or admin.
//!
//! What is NOT here, on purpose
//! ----------------------------
//! * No sales logic: the marketplace is a separate contract (build step 5).
//! * Pause stops *minting* only. Collectors' transfers are never frozen by the
//!   platform — their ownership is their property.
//! * No upgradeability in v1: redeploy rather than mutate a live contract.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, Address, BytesN, Env, String, Symbol, Vec,
};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_contract_utils::pausable::{self as pausable, Pausable};
use stellar_macros::{only_admin, only_role, when_not_paused};
use stellar_tokens::non_fungible::{
    royalties::{NonFungibleRoyalties, Royalties, RoyaltySupport},
    Base, Compose, NonFungibleToken,
};

pub const ROLE_VERIFIER: Symbol = symbol_short!("verifier");
pub const ROLE_ARTIST: Symbol = symbol_short!("artist");

/// 10 000 basis points = 100 %. Artist royalty may never exceed 50 %.
const MAX_ARTIST_ROYALTY_BPS: u32 = 5_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum WorksError {
    /// Royalty basis points above the allowed maximum.
    RoyaltyTooHigh = 100,
    /// IPFS CID or hash was empty.
    EmptyContent = 101,
    /// No work record exists for this token id.
    WorkNotFound = 102,
    /// This SHA-256 has already been minted (duplicate upload).
    DuplicateContent = 103,
}

/// Immutable record written at mint. The *provenance* of a work.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Work {
    /// The vetted artist who minted it (also the royalty receiver).
    pub artist: Address,
    /// Platform collection the work belongs to, e.g. 1 = "If Flowers Went to War".
    pub collection: u32,
    /// IPFS CID of the metadata JSON (which itself points at the image CID).
    pub cid: String,
    /// SHA-256 of the canonical image file. Lets anyone verify a file is the vetted one.
    pub sha256: BytesN<32>,
    /// Ledger sequence at mint.
    pub minted_at: u32,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// token_id -> Work
    Work(u32),
    /// sha256 -> token_id  (duplicate guard)
    Hash(BytesN<32>),
    /// u32: artist royalty in basis points applied at mint
    ArtistRoyaltyBps,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkMinted {
    #[topic]
    pub token_id: u32,
    #[topic]
    pub artist: Address,
    pub collection: u32,
    pub cid: String,
    pub sha256: BytesN<32>,
}

#[contract]
pub struct MorianahWorks;

#[contractimpl]
impl MorianahWorks {
    /// Deploy-time setup.
    ///
    /// * `admin`  — the platform multisig.
    /// * `base_uri` — prefix for token_uri; a gateway such as `ipfs://`.
    /// * `artist_royalty_bps` — royalty each artist receives on resale (e.g. 1000 = 10 %).
    pub fn __constructor(
        e: &Env,
        admin: Address,
        name: String,
        symbol: String,
        base_uri: String,
        artist_royalty_bps: u32,
    ) {
        if artist_royalty_bps > MAX_ARTIST_ROYALTY_BPS {
            panic_with_error!(e, WorksError::RoyaltyTooHigh);
        }
        Base::set_metadata(e, base_uri, name, symbol);
        access_control::set_admin(e, &admin);
        // Verifiers administer the artist role: grant_role/revoke_role on
        // "artist" now require the caller to be a verifier or the admin.
        access_control::set_role_admin_no_auth(e, &ROLE_ARTIST, &ROLE_VERIFIER);
        e.storage().instance().set(&DataKey::ArtistRoyaltyBps, &artist_royalty_bps);
    }

    // ---------------------------------------------------------------- minting

    /// Mint a vetted work. Only an approved artist may call this, and only
    /// while minting is not paused. The token is minted to the artist.
    ///
    /// Returns the new token id.
    #[only_role(artist, "artist")]
    #[when_not_paused]
    pub fn mint_work(
        e: &Env,
        artist: Address,
        collection: u32,
        cid: String,
        sha256: BytesN<32>,
    ) -> u32 {
        if cid.is_empty() {
            panic_with_error!(e, WorksError::EmptyContent);
        }
        if sha256 == BytesN::from_array(e, &[0u8; 32]) {
            panic_with_error!(e, WorksError::EmptyContent);
        }
        if e.storage().persistent().has(&DataKey::Hash(sha256.clone())) {
            panic_with_error!(e, WorksError::DuplicateContent);
        }

        let token_id = <Self as NonFungibleToken>::ContractType::mint(e, &artist);

        let bps: u32 = e
            .storage()
            .instance()
            .get(&DataKey::ArtistRoyaltyBps)
            .unwrap_or(0);
        if bps > 0 {
            <Self as NonFungibleToken>::ContractType::set_token_royalty(e, token_id, &artist, bps);
        }

        let work = Work {
            artist: artist.clone(),
            collection,
            cid: cid.clone(),
            sha256: sha256.clone(),
            minted_at: e.ledger().sequence(),
        };
        e.storage().persistent().set(&DataKey::Work(token_id), &work);
        e.storage().persistent().set(&DataKey::Hash(sha256.clone()), &token_id);

        WorkMinted { token_id, artist, collection, cid, sha256 }.publish(e);
        token_id
    }

    // ---------------------------------------------------------------- reads

    /// Provenance record for a token.
    pub fn work(e: &Env, token_id: u32) -> Work {
        e.storage()
            .persistent()
            .get(&DataKey::Work(token_id))
            .unwrap_or_else(|| panic_with_error!(e, WorksError::WorkNotFound))
    }

    /// Token id that carries a given file hash, if any. Use this to check an
    /// image against the vetted original.
    pub fn token_by_hash(e: &Env, sha256: BytesN<32>) -> Option<u32> {
        e.storage().persistent().get(&DataKey::Hash(sha256))
    }

    /// Royalty (basis points) applied to each artist at mint.
    pub fn artist_royalty_bps(e: &Env) -> u32 {
        e.storage().instance().get(&DataKey::ArtistRoyaltyBps).unwrap_or(0)
    }

    /// True if `account` is currently an approved artist.
    pub fn is_artist(e: &Env, account: Address) -> bool {
        access_control::has_role(e, &account, &ROLE_ARTIST).is_some()
    }

    /// True if `account` is currently a verifier.
    pub fn is_verifier(e: &Env, account: Address) -> bool {
        access_control::has_role(e, &account, &ROLE_VERIFIER).is_some()
    }

    // ---------------------------------------------------------------- admin

    /// Change the royalty applied to *future* mints. Existing tokens keep theirs.
    #[only_admin]
    pub fn set_artist_royalty_bps(e: &Env, bps: u32) {
        if bps > MAX_ARTIST_ROYALTY_BPS {
            panic_with_error!(e, WorksError::RoyaltyTooHigh);
        }
        e.storage().instance().set(&DataKey::ArtistRoyaltyBps, &bps);
    }
}

// Standard NFT interface (balance, owner_of, transfer, approve, token_uri …)
// plus ERC-2981-style royalty_info, all from the audited library.
#[contractimpl(contracttrait)]
impl NonFungibleToken for MorianahWorks {
    type ContractType = Compose<(Base, Royalties)>;
}

// Royalty management is admin-only. Per-token royalties are set at mint.
#[contractimpl(contracttrait)]
impl NonFungibleRoyalties for MorianahWorks {
    #[only_admin]
    fn set_default_royalty(e: &Env, receiver: Address, basis_points: u32, _operator: Address) {
        Base::set_default_royalty(e, &receiver, basis_points);
    }

    #[only_admin]
    fn set_token_royalty(
        e: &Env,
        token_id: u32,
        receiver: Address,
        basis_points: u32,
        _operator: Address,
    ) {
        Self::ContractType::set_token_royalty(e, token_id, &receiver, basis_points);
    }

    #[only_admin]
    fn remove_token_royalty(e: &Env, token_id: u32, _operator: Address) {
        Self::ContractType::remove_token_royalty(e, token_id);
    }
}

// grant_role / revoke_role / has_role / transfer_admin_role … from the library.
// Because "verifier" is the admin role of "artist", a verifier can grant or
// revoke "artist"; only the admin can grant or revoke "verifier".
#[contractimpl(contracttrait)]
impl AccessControl for MorianahWorks {}

// Pause / unpause minting. Admin only.
#[contractimpl(contracttrait)]
impl Pausable for MorianahWorks {
    #[only_admin]
    fn pause(e: &Env, _caller: Address) {
        pausable::pause(e);
    }

    #[only_admin]
    fn unpause(e: &Env, _caller: Address) {
        pausable::unpause(e);
    }
}

