#![cfg(test)]
//! Tests for the one-call `anchor`, `upgrade` and the admin-only imports.

extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, AuthorizedFunction, Events};
use soroban_sdk::{symbol_short, vec, Address, BytesN, Env, IntoVal, String, Symbol, TryFromVal, Vec};

struct Setup<'a> {
    client: DoqtriRegistryClient<'a>,
    admin: Address,
    owner: Address,
}

fn setup(env: &Env) -> Setup<'_> {
    let admin = Address::generate(env);
    let contract_id = env.register(DoqtriRegistry, (admin.clone(),));
    Setup {
        client: DoqtriRegistryClient::new(env, &contract_id),
        admin,
        owner: Address::generate(env),
    }
}

fn hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn s(env: &Env, text: &str) -> String {
    String::from_str(env, text)
}

fn update(env: &Env, node_id: &str, status: NodeStatus) -> NodeUpdate {
    NodeUpdate {
        node_id: s(env, node_id),
        status,
        tool: s(env, "doqtri-done"),
        artifact_ref: s(env, "v1"),
    }
}

#[test]
fn anchor_registers_a_new_document_with_its_nodes_in_one_call() {
    let env = Env::default();
    env.mock_all_auths();
    let t = setup(&env);
    let doc_id = s(&env, "plan");

    let nodes = vec![
        &env,
        update(&env, "root", NodeStatus::Verified),
        update(&env, "design", NodeStatus::Built),
    ];
    let version = t.client.anchor(&t.owner, &doc_id, &hash(&env, 1), &nodes);

    assert_eq!(version, 1);
    let doc = t.client.get_document(&doc_id);
    assert_eq!(doc.owner, t.owner);
    assert_eq!(doc.content_hash, hash(&env, 1));
    assert_eq!(doc.node_count, 2);
    assert_eq!(t.client.get_node(&doc_id, &s(&env, "root")).status, NodeStatus::Verified);
    assert_eq!(t.client.get_node(&doc_id, &s(&env, "design")).status, NodeStatus::Built);
}

#[test]
fn anchor_bumps_the_version_only_when_the_text_changed() {
    let env = Env::default();
    env.mock_all_auths();
    let t = setup(&env);
    let doc_id = s(&env, "plan");
    let none: Vec<NodeUpdate> = Vec::new(&env);

    assert_eq!(t.client.anchor(&t.owner, &doc_id, &hash(&env, 1), &none), 1);
    // Same text, new node status: no new version.
    let v = t
        .client
        .anchor(&t.owner, &doc_id, &hash(&env, 1), &vec![&env, update(&env, "root", NodeStatus::Verified)]);
    assert_eq!(v, 1);
    // New text: v2, in the same call as more node updates.
    let v = t
        .client
        .anchor(&t.owner, &doc_id, &hash(&env, 2), &vec![&env, update(&env, "root", NodeStatus::Verified)]);
    assert_eq!(v, 2);
    assert_eq!(t.client.get_document(&doc_id).content_hash, hash(&env, 2));
}

#[test]
fn anchor_counts_each_node_once() {
    let env = Env::default();
    env.mock_all_auths();
    let t = setup(&env);
    let doc_id = s(&env, "plan");

    t.client.anchor(&t.owner, &doc_id, &hash(&env, 1), &vec![&env, update(&env, "a", NodeStatus::Planned)]);
    t.client.anchor(
        &t.owner,
        &doc_id,
        &hash(&env, 1),
        &vec![&env, update(&env, "a", NodeStatus::Built), update(&env, "b", NodeStatus::Planned)],
    );
    assert_eq!(t.client.get_document(&doc_id).node_count, 2);
    assert_eq!(t.client.get_node(&doc_id, &s(&env, "a")).status, NodeStatus::Built);
}

#[test]
fn anchor_needs_the_owners_signature() {
    let env = Env::default();
    env.mock_all_auths();
    let t = setup(&env);
    let doc_id = s(&env, "plan");
    let none: Vec<NodeUpdate> = Vec::new(&env);

    t.client.anchor(&t.owner, &doc_id, &hash(&env, 1), &none);
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, t.owner);
    match &auths[0].1.function {
        AuthorizedFunction::Contract((_, name, _)) => assert_eq!(*name, Symbol::new(&env, "anchor")),
        _ => panic!("expected a contract call"),
    }
}

#[test]
fn anchor_without_any_signature_is_refused() {
    let env = Env::default();
    let t = setup(&env);
    let none: Vec<NodeUpdate> = Vec::new(&env);
    assert!(t.client.try_anchor(&t.owner, &s(&env, "plan"), &hash(&env, 1), &none).is_err());
}

#[test]
fn anchor_refuses_someone_elses_document() {
    let env = Env::default();
    env.mock_all_auths();
    let t = setup(&env);
    let doc_id = s(&env, "plan");
    let none: Vec<NodeUpdate> = Vec::new(&env);
    t.client.anchor(&t.owner, &doc_id, &hash(&env, 1), &none);

    let stranger = Address::generate(&env);
    let result = t.client.try_anchor(&stranger, &doc_id, &hash(&env, 9), &none);
    assert_eq!(result, Err(Ok(Error::NotOwner)));
    assert_eq!(t.client.get_document(&doc_id).content_hash, hash(&env, 1));
}

#[test]
fn anchor_refuses_too_many_nodes() {
    let env = Env::default();
    env.mock_all_auths();
    let t = setup(&env);

    let mut nodes = Vec::new(&env);
    for _ in 0..=MAX_NODES_PER_CALL {
        nodes.push_back(update(&env, "n", NodeStatus::Planned));
    }
    let result = t.client.try_anchor(&t.owner, &s(&env, "plan"), &hash(&env, 1), &nodes);
    assert_eq!(result, Err(Ok(Error::TooManyNodes)));
}

#[test]
fn anchor_works_on_documents_from_the_old_calls() {
    let env = Env::default();
    env.mock_all_auths();
    let t = setup(&env);
    let doc_id = s(&env, "plan");
    t.client.register_document(&t.owner, &doc_id, &hash(&env, 1));

    let v = t
        .client
        .anchor(&t.owner, &doc_id, &hash(&env, 2), &vec![&env, update(&env, "root", NodeStatus::Verified)]);
    assert_eq!(v, 2);
    // And the old calls still work after it.
    assert_eq!(t.client.update_document(&doc_id, &hash(&env, 3)), 3);
}

/// The indexer keys off these events, so `anchor` emits the same ones as the
/// separate calls: register (new doc), update (changed text), node (any nodes).
#[test]
fn anchor_emits_the_same_events_as_the_separate_calls() {
    let env = Env::default();
    env.mock_all_auths();
    let t = setup(&env);
    let doc_id = s(&env, "plan");

    let actions = |env: &Env| -> std::vec::Vec<Symbol> {
        env.events()
            .all()
            .iter()
            .map(|ev| {
                assert_eq!(String::try_from_val(env, &ev.2).unwrap(), doc_id);
                Symbol::try_from_val(env, &ev.1.get(1).unwrap()).unwrap()
            })
            .collect()
    };

    t.client.anchor(&t.owner, &doc_id, &hash(&env, 1), &vec![&env, update(&env, "root", NodeStatus::Built)]);
    assert_eq!(actions(&env), [symbol_short!("register"), symbol_short!("node")]);

    t.client.anchor(&t.owner, &doc_id, &hash(&env, 2), &Vec::new(&env));
    assert_eq!(actions(&env), [symbol_short!("update")]);
}

#[test]
fn admin_is_set_at_deploy() {
    let env = Env::default();
    let t = setup(&env);
    assert_eq!(t.client.admin(), t.admin);
}

#[test]
fn upgrade_and_imports_need_the_admin() {
    let env = Env::default();
    let t = setup(&env);
    let doc = Document {
        owner: t.owner.clone(),
        content_hash: hash(&env, 7),
        version: 4,
        node_count: 1,
        updated_at: 1_700_000_000,
    };
    // Nobody signed: all three are refused.
    assert!(t.client.try_upgrade(&hash(&env, 1)).is_err());
    assert!(t.client.try_import_document(&s(&env, "old"), &doc).is_err());

    // The owner of a document is not the admin.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &t.owner,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &t.client.address,
            fn_name: "import_document",
            args: (s(&env, "old"), doc.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(t.client.try_import_document(&s(&env, "old"), &doc).is_err());
}

#[test]
fn import_copies_a_document_and_its_nodes_as_they_were() {
    let env = Env::default();
    env.mock_all_auths();
    let t = setup(&env);
    let doc_id = s(&env, "old");
    let doc = Document {
        owner: t.owner.clone(),
        content_hash: hash(&env, 7),
        version: 4,
        node_count: 1,
        updated_at: 1_700_000_000,
    };
    let node = NodeRecord {
        status: NodeStatus::Verified,
        tool: s(&env, "n8n"),
        artifact_ref: s(&env, "wf_1"),
        updated_at: 1_700_000_000,
    };

    t.client.import_document(&doc_id, &doc);
    t.client.import_node(&doc_id, &s(&env, "root"), &node);
    assert_eq!(env.auths()[0].0, t.admin);

    assert_eq!(t.client.get_document(&doc_id), doc);
    assert_eq!(t.client.get_node(&doc_id, &s(&env, "root")), node);
    // Importing twice is refused, and the owner carries on from v4.
    assert_eq!(t.client.try_import_document(&doc_id, &doc), Err(Ok(Error::DocumentAlreadyExists)));
    assert_eq!(t.client.update_document(&doc_id, &hash(&env, 8)), 5);
    // A node can't be imported for a document that isn't there.
    assert_eq!(
        t.client.try_import_node(&s(&env, "missing"), &s(&env, "root"), &node),
        Err(Ok(Error::DocumentNotFound))
    );
}
