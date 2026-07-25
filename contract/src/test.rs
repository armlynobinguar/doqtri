#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, String, Symbol};

fn setup(env: &Env) -> (DoqtriRegistryClient<'_>, Address) {
    let contract_id = env.register(DoqtriRegistry, ());
    let client = DoqtriRegistryClient::new(env, &contract_id);
    let owner = Address::generate(env);
    (client, owner)
}

fn hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

#[test]
fn test_register_document() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, owner) = setup(&env);

    let doc_id = String::from_str(&env, "doqtri-launch-plan");
    let version = client.register_document(&owner, &doc_id, &hash(&env, 1));
    assert_eq!(version, 1);

    let doc = client.get_document(&doc_id);
    assert_eq!(doc.owner, owner);
    assert_eq!(doc.version, 1);
    assert_eq!(doc.node_count, 0);
    assert_eq!(doc.content_hash, hash(&env, 1));
}

#[test]
fn test_duplicate_register_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, owner) = setup(&env);

    let doc_id = String::from_str(&env, "doqtri-launch-plan");
    client.register_document(&owner, &doc_id, &hash(&env, 1));

    let result = client.try_register_document(&owner, &doc_id, &hash(&env, 2));
    assert_eq!(result, Err(Ok(Error::DocumentAlreadyExists)));
}

#[test]
fn test_update_increments_version() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, owner) = setup(&env);

    let doc_id = String::from_str(&env, "doqtri-launch-plan");
    client.register_document(&owner, &doc_id, &hash(&env, 1));

    let v2 = client.update_document(&doc_id, &hash(&env, 2));
    assert_eq!(v2, 2);
    let v3 = client.update_document(&doc_id, &hash(&env, 3));
    assert_eq!(v3, 3);

    let doc = client.get_document(&doc_id);
    assert_eq!(doc.version, 3);
    assert_eq!(doc.content_hash, hash(&env, 3));
}

#[test]
fn test_update_missing_document_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _owner) = setup(&env);

    let doc_id = String::from_str(&env, "ghost-doc");
    let result = client.try_update_document(&doc_id, &hash(&env, 9));
    assert_eq!(result, Err(Ok(Error::DocumentNotFound)));
}

#[test]
fn test_node_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, owner) = setup(&env);

    let doc_id = String::from_str(&env, "doqtri-launch-plan");
    let node_id = String::from_str(&env, "node-weekly-report");
    client.register_document(&owner, &doc_id, &hash(&env, 1));

    // Planned -> Building -> Built -> Verified
    client.set_node_status(
        &doc_id,
        &node_id,
        &NodeStatus::Planned,
        &String::from_str(&env, "n8n"),
        &String::from_str(&env, ""),
    );
    client.set_node_status(
        &doc_id,
        &node_id,
        &NodeStatus::Built,
        &String::from_str(&env, "n8n"),
        &String::from_str(&env, "wf_8Xk2p"),
    );
    client.set_node_status(
        &doc_id,
        &node_id,
        &NodeStatus::Verified,
        &String::from_str(&env, "n8n"),
        &String::from_str(&env, "wf_8Xk2p"),
    );

    let node = client.get_node(&doc_id, &node_id);
    assert_eq!(node.status, NodeStatus::Verified);
    assert_eq!(node.tool, String::from_str(&env, "n8n"));
    assert_eq!(node.artifact_ref, String::from_str(&env, "wf_8Xk2p"));

    // node_count increments only once per unique node
    let doc = client.get_document(&doc_id);
    assert_eq!(doc.node_count, 1);
}

#[test]
fn test_multiple_nodes_counted() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, owner) = setup(&env);

    let doc_id = String::from_str(&env, "doqtri-launch-plan");
    client.register_document(&owner, &doc_id, &hash(&env, 1));

    for name in ["node-a", "node-b", "node-c"] {
        client.set_node_status(
            &doc_id,
            &String::from_str(&env, name),
            &NodeStatus::Planned,
            &String::from_str(&env, "retool"),
            &String::from_str(&env, ""),
        );
    }

    assert_eq!(client.get_document(&doc_id).node_count, 3);
}

#[test]
fn test_get_missing_node_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, owner) = setup(&env);

    let doc_id = String::from_str(&env, "doqtri-launch-plan");
    client.register_document(&owner, &doc_id, &hash(&env, 1));

    let result = client.try_get_node(&doc_id, &String::from_str(&env, "ghost-node"));
    assert_eq!(result, Err(Ok(Error::NodeNotFound)));
}

#[test]
fn test_auth_is_required() {
    let env = Env::default();
    let (client, owner) = setup(&env);

    let doc_id = String::from_str(&env, "doqtri-launch-plan");
    // No mock_all_auths — the host must reject the unauthorized call.
    let result = client.try_register_document(&owner, &doc_id, &hash(&env, 1));
    assert!(result.is_err());
}

/// Events always carry `doc_id` so the web vault can sync from the indexer.
#[test]
fn test_events_emit_doc_id() {
    use soroban_sdk::testutils::Events;
    use soroban_sdk::{symbol_short, TryFromVal};

    let env = Env::default();
    env.mock_all_auths();
    let (client, owner) = setup(&env);

    let doc_id = String::from_str(&env, "doc-events");
    let node_id = String::from_str(&env, "milestone");

    client.register_document(&owner, &doc_id, &hash(&env, 1));
    client.update_document(&doc_id, &hash(&env, 2));
    client.set_node_status(
        &doc_id,
        &node_id,
        &NodeStatus::Built,
        &String::from_str(&env, "n8n"),
        &String::from_str(&env, "wf_1"),
    );

    let events = env.events().all();
    assert_eq!(events.len(), 3);

    let expected_actions = [
        symbol_short!("register"),
        symbol_short!("update"),
        symbol_short!("node"),
    ];

    for (i, ev) in events.iter().enumerate() {
        let topics = ev.1;
        let topic0 = topics.get(0).unwrap();
        let topic1 = topics.get(1).unwrap();
        assert_eq!(
            Symbol::try_from_val(&env, &topic0).unwrap(),
            symbol_short!("doqtri")
        );
        assert_eq!(
            Symbol::try_from_val(&env, &topic1).unwrap(),
            expected_actions[i]
        );
        let emitted = String::try_from_val(&env, &ev.2).unwrap();
        assert_eq!(emitted, doc_id);
    }
}

/// Mirrors the UI write path: register → update hash → set_node_status.
#[test]
fn test_ui_write_path() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, owner) = setup(&env);

    let doc_id = String::from_str(&env, "doc-ui-path");
    let node_id = String::from_str(&env, "first-milestone");

    let v1 = client.register_document(&owner, &doc_id, &hash(&env, 0x11));
    assert_eq!(v1, 1);

    // Idempotent retry surface: duplicate register must fail with AlreadyExists
    // (JS client maps this to update_document).
    let dup = client.try_register_document(&owner, &doc_id, &hash(&env, 0x22));
    assert_eq!(dup, Err(Ok(Error::DocumentAlreadyExists)));

    let v2 = client.update_document(&doc_id, &hash(&env, 0x22));
    assert_eq!(v2, 2);

    client.set_node_status(
        &doc_id,
        &node_id,
        &NodeStatus::Building,
        &String::from_str(&env, "n8n"),
        &String::from_str(&env, "wf_draft"),
    );
    client.set_node_status(
        &doc_id,
        &node_id,
        &NodeStatus::Verified,
        &String::from_str(&env, "n8n"),
        &String::from_str(&env, "wf_live"),
    );

    let doc = client.get_document(&doc_id);
    assert_eq!(doc.version, 2);
    assert_eq!(doc.node_count, 1);
    assert_eq!(doc.content_hash, hash(&env, 0x22));

    let node = client.get_node(&doc_id, &node_id);
    assert_eq!(node.status, NodeStatus::Verified);
    assert_eq!(node.tool, String::from_str(&env, "n8n"));
    assert_eq!(node.artifact_ref, String::from_str(&env, "wf_live"));
}
