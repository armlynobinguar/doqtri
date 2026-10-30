#![cfg(test)]
//! Upgrade compatibility: records written by the registry that is live on
//! testnet today must still load, and keep updating, after this code
//! replaces it at the same address (D-18).
//!
//! `fixtures/doqtri_registry_v2.wasm` is that contract's code, fetched from
//! testnet (`stellar contract fetch --id CCCIDUCF…F6QRJ`); its hash is the
//! README's testnet WASM hash, 9c892100…bb741330.

extern crate std;

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{vec, Address, BytesN, Env, String};

mod v2 {
    soroban_sdk::contractimport!(file = "fixtures/doqtri_registry_v2.wasm");
}

struct Legacy {
    contract: Address,
    admin: Address,
    owner: Address,
}

fn s(env: &Env, text: &str) -> String {
    String::from_str(env, text)
}

fn hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

/// Deploys the live v2 code and writes through every one of its write paths:
/// `register_document` + `update_document` + `set_node_status` on "legacy",
/// and one `anchor` with two nodes on "anchored".
fn write_with_v2(env: &Env) -> Legacy {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let owner = Address::generate(env);
    let contract = env.register(v2::WASM, (admin.clone(),));
    let old = v2::Client::new(env, &contract);

    let legacy = s(env, "legacy");
    old.register_document(&owner, &legacy, &hash(env, 1));
    assert_eq!(old.update_document(&legacy, &hash(env, 2)), 2);
    old.set_node_status(&legacy, &s(env, "root"), &v2::NodeStatus::Built, &s(env, "n8n"), &s(env, "wf_1"));

    let nodes = vec![
        env,
        v2::NodeUpdate {
            node_id: s(env, "root"),
            status: v2::NodeStatus::Verified,
            tool: s(env, "doqtri-done"),
            artifact_ref: s(env, "v1"),
        },
        v2::NodeUpdate {
            node_id: s(env, "api"),
            status: v2::NodeStatus::Planned,
            tool: s(env, "doqtri-done"),
            artifact_ref: s(env, "v1"),
        },
    ];
    assert_eq!(old.anchor(&owner, &s(env, "anchored"), &hash(env, 7), &nodes), 1);

    Legacy { contract, admin, owner }
}

/// What the old code wrote, read back with this crate's `DataKey` and types
/// straight from storage: same keys, same layouts.
fn assert_raw_records_decode(env: &Env, t: &Legacy) {
    env.as_contract(&t.contract, || {
        let store = env.storage().persistent();
        let doc: Document = store.get(&DataKey::Doc(s(env, "legacy"))).unwrap();
        assert_eq!(doc.owner, t.owner);
        assert_eq!((doc.content_hash, doc.version, doc.node_count), (hash(env, 2), 2, 1));
        let node: NodeRecord = store.get(&DataKey::Node(s(env, "legacy"), s(env, "root"))).unwrap();
        assert_eq!(node.status, NodeStatus::Built);
        assert_eq!((node.tool, node.artifact_ref), (s(env, "n8n"), s(env, "wf_1")));
        let anchored: Document = store.get(&DataKey::Doc(s(env, "anchored"))).unwrap();
        assert_eq!((anchored.version, anchored.node_count), (1, 2));
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        assert_eq!(admin, t.admin);
    });
}

/// After the upgrade: the old records load through the new getters, the old
/// owner-only calls keep working on them, and the workspace calls work on
/// them too. Then the old calls again, after the new ones were used.
fn assert_old_records_work_after_upgrade(env: &Env, t: &Legacy) {
    env.mock_all_auths();
    let client = DoqtriRegistryClient::new(env, &t.contract);
    let legacy = s(env, "legacy");
    let anchored = s(env, "anchored");

    let doc = client.get_document(&legacy);
    assert_eq!(doc.owner, t.owner);
    assert_eq!((doc.content_hash, doc.version, doc.node_count), (hash(env, 2), 2, 1));
    let node = client.get_node(&legacy, &s(env, "root"));
    assert_eq!((node.status, node.tool), (NodeStatus::Built, s(env, "n8n")));
    assert_eq!(client.get_node(&anchored, &s(env, "root")).status, NodeStatus::Verified);
    assert_eq!(client.get_node(&anchored, &s(env, "api")).status, NodeStatus::Planned);

    // The new calls, on the old records.
    let ws = s(env, "ws-1");
    let editor = Address::generate(env);
    client.create_workspace(&ws, &t.owner);
    client.add_editor(&ws, &t.owner, &editor);
    client.assign_document(&legacy, &ws);
    client.assign_document(&anchored, &ws);
    assert_eq!(client.update_document_as(&editor, &legacy, &hash(env, 3)), 3);
    client.set_node_status_as(&editor, &legacy, &s(env, "root"), &NodeStatus::Verified, &s(env, "qdit"), &s(env, "qdit:testnet:C1:p/m@v1"));
    client.set_node_status_as(&editor, &legacy, &s(env, "new"), &NodeStatus::Planned, &s(env, "qdit"), &s(env, ""));
    let nodes = vec![env, NodeUpdate {
        node_id: s(env, "api"),
        status: NodeStatus::Built,
        tool: s(env, "qdit"),
        artifact_ref: s(env, "qdit:testnet:C1:p/m2@v1"),
    }];
    assert_eq!(client.anchor_as(&editor, &anchored, &hash(env, 8), &nodes), 2);

    let doc = client.get_document(&legacy);
    assert_eq!((doc.version, doc.node_count, doc.owner.clone()), (3, 2, t.owner.clone()));
    assert_eq!(client.get_node(&legacy, &s(env, "root")).status, NodeStatus::Verified);
    assert_eq!(client.get_node(&anchored, &s(env, "api")).status, NodeStatus::Built);
    assert_eq!(client.get_document(&anchored).node_count, 2);

    // And the original owner-only calls still work after the new ones.
    assert_eq!(client.update_document(&legacy, &hash(env, 4)), 4);
    client.set_node_status(&legacy, &s(env, "root"), &NodeStatus::Building, &s(env, "n8n"), &s(env, "wf_2"));
    assert_eq!(client.anchor(&t.owner, &anchored, &hash(env, 9), &Vec::new(env)), 3);
    assert_eq!(client.get_node(&legacy, &s(env, "root")).status, NodeStatus::Building);
    assert_eq!(client.get_document(&legacy).version, 4);
    // Registering an old id is still refused.
    assert_eq!(client.try_register_document(&t.owner, &legacy, &hash(env, 1)), Err(Ok(Error::DocumentAlreadyExists)));

    // A transfer moves the old records with the workspace, without
    // rewriting them: the old owner-only calls now ask the new owner.
    let heir = Address::generate(env);
    client.transfer_workspace(&ws, &t.owner, &heir);
    assert_eq!(client.get_document(&legacy).owner, heir);
    assert_eq!(client.update_document(&legacy, &hash(env, 5)), 5);
    assert_eq!(env.auths()[0].0, heir);
    assert_eq!(client.try_anchor(&t.owner, &anchored, &hash(env, 10), &Vec::new(env)), Err(Ok(Error::NotOwner)));
    assert_eq!(client.anchor(&heir, &anchored, &hash(env, 10), &Vec::new(env)), 4);
}

/// Swaps in this crate's code at the v2 contract's address. The test host
/// re-runs the constructor on re-registration (it does not on-chain), so it
/// gets the same admin back. Runs in CI with no wasm build.
#[test]
fn records_written_by_the_live_v2_code_load_and_update_after_the_upgrade() {
    let env = Env::default();
    let t = write_with_v2(&env);
    assert_raw_records_decode(&env, &t);

    env.register_at(&t.contract, DoqtriRegistry, (t.admin.clone(),));
    assert_old_records_work_after_upgrade(&env, &t);
}

/// The real path: v2's own admin `upgrade()` to this crate's built wasm,
/// at the same address, with no constructor re-run. Needs the wasm built
/// first: `stellar contract build` in contract/, then
/// `cargo test -p doqtri-registry -- --ignored`.
#[test]
#[ignore = "needs the wasm from `stellar contract build`"]
fn upgrade_through_the_admin_call_keeps_every_record() {
    let target = std::env::var("CARGO_TARGET_DIR")
        .unwrap_or_else(|_| std::format!("{}/../target", env!("CARGO_MANIFEST_DIR")));
    let path = std::format!("{target}/wasm32v1-none/release/doqtri_registry.wasm");
    let wasm = std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"));

    // No snapshot: it would embed the built wasm and change with every build.
    let env = Env::new_with_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    let t = write_with_v2(&env);
    let new_hash = env
        .deployer()
        .upload_contract_wasm(soroban_sdk::Bytes::from_slice(&env, &wasm));
    v2::Client::new(&env, &t.contract).upgrade(&new_hash);
    assert_eq!(env.auths()[0].0, t.admin);

    let client = DoqtriRegistryClient::new(&env, &t.contract);
    // Instance storage survived: the admin is still the admin.
    assert_eq!(client.admin(), t.admin);
    assert_raw_records_decode(&env, &t);
    assert_old_records_work_after_upgrade(&env, &t);
}
