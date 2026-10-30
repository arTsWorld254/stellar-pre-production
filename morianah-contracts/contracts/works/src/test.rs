//! Tests for Morianah Works. Each test states the rule it proves.
//!
//! Run: `cargo test -p morianah-works`

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Events as _, MockAuth, MockAuthInvoke},
    Address, BytesN, Env, IntoVal, String,
};

use crate::contract::{MorianahWorks, MorianahWorksClient, ROLE_ARTIST, ROLE_VERIFIER};

const ROYALTY_BPS: u32 = 1_000; // 10 %

struct World<'a> {
    e: Env,
    client: MorianahWorksClient<'a>,
    admin: Address,
    verifier: Address,
    artist: Address,
    collector: Address,
}

fn world<'a>() -> World<'a> {
    let e = Env::default();
    let admin = Address::generate(&e);
    let verifier = Address::generate(&e);
    let artist = Address::generate(&e);
    let collector = Address::generate(&e);
    let id = e.register(
        MorianahWorks,
        (
            admin.clone(),
            String::from_str(&e, "Morianah Works"),
            String::from_str(&e, "MORI"),
            String::from_str(&e, "ipfs://"),
            ROYALTY_BPS,
        ),
    );
    let client = MorianahWorksClient::new(&e, &id);
    World { e, client, admin, verifier, artist, collector }
}

fn cid(e: &Env, s: &str) -> String {
    String::from_str(e, s)
}

fn hash(e: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(e, &[seed; 32])
}

/// Admin grants verifier; verifier grants artist. Uses mock_all_auths for setup.
fn onboard(w: &World) {
    w.e.mock_all_auths();
    w.client.grant_role(&w.verifier, &ROLE_VERIFIER, &w.admin);
    w.client.grant_role(&w.artist, &ROLE_ARTIST, &w.verifier);
}

// ------------------------------------------------------------------ setup

#[test]
fn constructor_sets_metadata_admin_and_role_hierarchy() {
    let w = world();
    assert_eq!(w.client.name(), String::from_str(&w.e, "Morianah Works"));
    assert_eq!(w.client.symbol(), String::from_str(&w.e, "MORI"));
    assert_eq!(w.client.get_admin(), Some(w.admin.clone()));
    assert_eq!(w.client.artist_royalty_bps(), ROYALTY_BPS);
    // "verifier" administers "artist"
    assert_eq!(w.client.get_role_admin(&ROLE_ARTIST), Some(ROLE_VERIFIER));
    assert!(!w.client.paused());
}

#[test]
#[should_panic(expected = "Error(Contract, #100)")]
fn constructor_rejects_royalty_above_fifty_percent() {
    let e = Env::default();
    let admin = Address::generate(&e);
    e.register(
        MorianahWorks,
        (
            admin,
            String::from_str(&e, "X"),
            String::from_str(&e, "X"),
            String::from_str(&e, "ipfs://"),
            5_001u32,
        ),
    );
}

// ------------------------------------------------------------------ roles

#[test]
fn verifier_can_approve_and_remove_artists() {
    let w = world();
    onboard(&w);
    assert!(w.client.is_verifier(&w.verifier));
    assert!(w.client.is_artist(&w.artist));

    w.client.revoke_role(&w.artist, &ROLE_ARTIST, &w.verifier);
    assert!(!w.client.is_artist(&w.artist));
}

#[test]
#[should_panic(expected = "Error(Contract, #2000)")]
fn artist_cannot_approve_other_artists() {
    // An artist is not the admin role of "artist" → Unauthorized.
    let w = world();
    onboard(&w);
    let other = Address::generate(&w.e);
    w.client.grant_role(&other, &ROLE_ARTIST, &w.artist);
}

#[test]
#[should_panic(expected = "Error(Contract, #2000)")]
fn verifier_cannot_create_other_verifiers() {
    // Only the admin administers "verifier".
    let w = world();
    onboard(&w);
    let other = Address::generate(&w.e);
    w.client.grant_role(&other, &ROLE_VERIFIER, &w.verifier);
}

#[test]
#[should_panic(expected = "Error(Contract, #2000)")]
fn random_account_cannot_grant_roles() {
    let w = world();
    w.e.mock_all_auths();
    let stranger = Address::generate(&w.e);
    w.client.grant_role(&w.artist, &ROLE_ARTIST, &stranger);
}

// ------------------------------------------------------------------ minting

#[test]
fn approved_artist_mints_and_record_is_written() {
    let w = world();
    onboard(&w);
    let h = hash(&w.e, 7);
    let id = w.client.mint_work(&w.artist, &1, &cid(&w.e, "bafy...flowers-024"), &h);
    // WorkMinted event emitted by the mint call
    assert!(!w.e.events().all().events().is_empty());

    assert_eq!(w.client.owner_of(&id), w.artist);
    assert_eq!(w.client.balance(&w.artist), 1);

    let work = w.client.work(&id);
    assert_eq!(work.artist, w.artist);
    assert_eq!(work.collection, 1);
    assert_eq!(work.cid, cid(&w.e, "bafy...flowers-024"));
    assert_eq!(work.sha256, h);
    assert_eq!(w.client.token_by_hash(&h), Some(id));
}

#[test]
fn mint_sets_artist_royalty() {
    let w = world();
    onboard(&w);
    let id = w.client.mint_work(&w.artist, &1, &cid(&w.e, "bafy1"), &hash(&w.e, 1));
    let (receiver, amount) = w.client.royalty_info(&id, &10_000);
    assert_eq!(receiver, w.artist);
    assert_eq!(amount, 1_000); // 10 % of 10 000
}

#[test]
fn royalty_change_applies_to_future_mints_only() {
    let w = world();
    onboard(&w);
    let first = w.client.mint_work(&w.artist, &1, &cid(&w.e, "a"), &hash(&w.e, 1));
    w.client.set_artist_royalty_bps(&500);
    let second = w.client.mint_work(&w.artist, &1, &cid(&w.e, "b"), &hash(&w.e, 2));
    assert_eq!(w.client.royalty_info(&first, &10_000).1, 1_000);
    assert_eq!(w.client.royalty_info(&second, &10_000).1, 500);
}

#[test]
#[should_panic(expected = "Error(Contract, #2000)")]
fn unapproved_account_cannot_mint() {
    let w = world();
    w.e.mock_all_auths();
    w.client.mint_work(&w.collector, &1, &cid(&w.e, "x"), &hash(&w.e, 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #2000)")]
fn removed_artist_cannot_mint() {
    let w = world();
    onboard(&w);
    w.client.revoke_role(&w.artist, &ROLE_ARTIST, &w.verifier);
    w.client.mint_work(&w.artist, &1, &cid(&w.e, "x"), &hash(&w.e, 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #103)")]
fn same_file_cannot_be_minted_twice() {
    let w = world();
    onboard(&w);
    let h = hash(&w.e, 9);
    w.client.mint_work(&w.artist, &1, &cid(&w.e, "a"), &h);
    w.client.mint_work(&w.artist, &1, &cid(&w.e, "b"), &h);
}

#[test]
#[should_panic(expected = "Error(Contract, #101)")]
fn empty_cid_is_rejected() {
    let w = world();
    onboard(&w);
    w.client.mint_work(&w.artist, &1, &cid(&w.e, ""), &hash(&w.e, 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #101)")]
fn zero_hash_is_rejected() {
    let w = world();
    onboard(&w);
    w.client.mint_work(&w.artist, &1, &cid(&w.e, "a"), &hash(&w.e, 0));
}

#[test]
#[should_panic(expected = "Error(Contract, #102)")]
fn unknown_token_has_no_work_record() {
    let w = world();
    w.client.work(&999);
}

// ------------------------------------------------------------------ authorization is real, not just role membership

#[test]
#[should_panic(expected = "Unauthorized")]
fn mint_requires_the_artists_own_signature() {
    // Role is held, but the artist did NOT sign: require_auth must fail.
    let w = world();
    onboard(&w); // mock_all_auths for the grants
    let w2 = World { e: w.e.clone(), ..w };
    // From here on only explicitly mocked auths are accepted.
    w2.e.set_auths(&[]);
    w2.client.mint_work(&w2.artist, &1, &cid(&w2.e, "a"), &hash(&w2.e, 1));
}

#[test]
fn mint_succeeds_with_only_the_artists_signature() {
    let w = world();
    onboard(&w);
    let contract = w.client.address.clone();
    let c = cid(&w.e, "a");
    let h = hash(&w.e, 1);
    w.e.mock_auths(&[MockAuth {
        address: &w.artist,
        invoke: &MockAuthInvoke {
            contract: &contract,
            fn_name: "mint_work",
            args: (w.artist.clone(), 1u32, c.clone(), h.clone()).into_val(&w.e),
            sub_invokes: &[],
        },
    }]);
    let id = w.client.mint_work(&w.artist, &1, &c, &h);
    assert_eq!(w.client.owner_of(&id), w.artist);
}

// ------------------------------------------------------------------ pause

#[test]
#[should_panic(expected = "Error(Contract, #1000)")]
fn pause_stops_minting() {
    // Pausable error: EnforcedPause = 1000
    let w = world();
    onboard(&w);
    w.client.pause(&w.admin);
    assert!(w.client.paused());
    w.client.mint_work(&w.artist, &1, &cid(&w.e, "a"), &hash(&w.e, 1));
}

#[test]
fn unpause_restores_minting_and_transfers_never_pause() {
    let w = world();
    onboard(&w);
    let id = w.client.mint_work(&w.artist, &1, &cid(&w.e, "a"), &hash(&w.e, 1));
    w.client.pause(&w.admin);
    // Collectors' property is never frozen by the platform.
    w.client.transfer(&w.artist, &w.collector, &id);
    assert_eq!(w.client.owner_of(&id), w.collector);
    w.client.unpause(&w.admin);
    w.client.mint_work(&w.artist, &1, &cid(&w.e, "b"), &hash(&w.e, 2));
}

#[test]
#[should_panic(expected = "Unauthorized")]
fn only_admin_can_pause() {
    // The gate is the admin's signature. Here only the verifier signs.
    let w = world();
    onboard(&w);
    let contract = w.client.address.clone();
    w.e.mock_auths(&[MockAuth {
        address: &w.verifier,
        invoke: &MockAuthInvoke {
            contract: &contract,
            fn_name: "pause",
            args: (w.verifier.clone(),).into_val(&w.e),
            sub_invokes: &[],
        },
    }]);
    w.client.pause(&w.verifier);
}

#[test]
#[should_panic(expected = "Unauthorized")]
fn only_admin_can_change_royalty_terms() {
    let w = world();
    onboard(&w);
    let contract = w.client.address.clone();
    w.e.mock_auths(&[MockAuth {
        address: &w.verifier,
        invoke: &MockAuthInvoke {
            contract: &contract,
            fn_name: "set_artist_royalty_bps",
            args: (250u32,).into_val(&w.e),
            sub_invokes: &[],
        },
    }]);
    w.client.set_artist_royalty_bps(&250);
}

// ------------------------------------------------------------------ ownership & resale

#[test]
fn owner_can_transfer_and_royalty_follows_the_token() {
    let w = world();
    onboard(&w);
    let id = w.client.mint_work(&w.artist, &1, &cid(&w.e, "a"), &hash(&w.e, 1));
    w.client.transfer(&w.artist, &w.collector, &id);
    assert_eq!(w.client.owner_of(&id), w.collector);
    // royalty still pays the artist after resale
    let (receiver, _) = w.client.royalty_info(&id, &1_000);
    assert_eq!(receiver, w.artist);
    // provenance record unchanged
    assert_eq!(w.client.work(&id).artist, w.artist);
}

#[test]
#[should_panic(expected = "Error(Contract, #201)")]
fn non_owner_cannot_transfer() {
    // NonFungibleToken error: IncorrectOwner = 201
    let w = world();
    onboard(&w);
    let id = w.client.mint_work(&w.artist, &1, &cid(&w.e, "a"), &hash(&w.e, 1));
    w.client.transfer(&w.collector, &w.artist, &id);
}

#[test]
fn token_uri_is_base_uri_plus_id() {
    let w = world();
    onboard(&w);
    let id = w.client.mint_work(&w.artist, &1, &cid(&w.e, "a"), &hash(&w.e, 1));
    assert_eq!(w.client.token_uri(&id), String::from_str(&w.e, "ipfs://0"));
}

// ------------------------------------------------------------------ admin handover

#[test]
fn admin_handover_is_two_step() {
    let w = world();
    w.e.mock_all_auths();
    let new_admin = Address::generate(&w.e);
    w.client.transfer_admin_role(&new_admin, &1_000);
    // still the old admin until accepted
    assert_eq!(w.client.get_admin(), Some(w.admin.clone()));
    w.client.accept_admin_transfer();
    assert_eq!(w.client.get_admin(), Some(new_admin));
}
