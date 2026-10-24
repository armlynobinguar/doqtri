#![cfg(test)]
//! Tests for `assign_document` and the `*_as` calls: workspace members
//! writing a document with their own signature, and everyone else refused.

extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Events, MockAuth, MockAuthInvoke};
use soroban_sdk::{symbol_short, vec, Address, BytesN, Env, IntoVal, String, Symbol, TryFromVal, Val, Vec};

struct Setup<'a> {
    env: &'a Env,
    client: DoqtriRegistryClient<'a>,
    /// Owns the workspace `ws-1`.
    owner: Address,
    admin: Address,
    editor: Address,
    revoker: Address,
    stranger: Address,
    /// An editor who anchored `plan` and put it in the workspace.
    author: Address,
}

fn s(env: &Env, text: &str) -> String {
    String::from_str(env, text)
}

fn hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn update(env: &Env, node_id: &str, status: NodeStatus) -> NodeUpdate {
    NodeUpdate {
        node_id: s(env, node_id),
        status,
        tool: s(env, "qdit"),
        artifact_ref: s(env, "qdit:testnet:C1:p1/m1@v1"),
    }
}

fn setup(env: &Env) -> Setup<'_> {
    env.mock_all_auths();
    let contract_admin = Address::generate(env);
    let contract_id = env.register(DoqtriRegistry, (contract_admin,));
    let t = Setup {
        env,
        client: DoqtriRegistryClient::new(env, &contract_id),
        owner: Address::generate(env),
        admin: Address::generate(env),
        editor: Address::generate(env),
        revoker: Address::generate(env),
        stranger: Address::generate(env),
        author: Address::generate(env),
    };
    let ws = t.ws();
    t.client.create_workspace(&ws, &t.owner);
    t.client.add_admin(&ws, &t.owner, &t.admin);
    t.client.add_editor(&ws, &t.admin, &t.editor);
    t.client.add_editor(&ws, &t.admin, &t.author);
    t.client.set_revoker(&ws, &t.owner, &t.revoker);
    t.client.anchor(&t.author, &t.plan(), &hash(env, 1), &vec![env, update(env, "root", NodeStatus::Planned)]);
    t.client.assign_document(&t.plan(), &ws);
    t
}

impl Setup<'_> {
    fn ws(&self) -> String {
        s(self.env, "ws-1")
    }

    fn plan(&self) -> String {
        s(self.env, "plan")
    }

    fn only<A: IntoVal<Env, Vec<Val>>>(&self, who: &Address, fn_name: &str, args: A) {
        self.env.mock_auths(&[MockAuth {
            address: who,
            invoke: &MockAuthInvoke {
                contract: &self.client.address,
                fn_name,
                args: args.into_val(self.env),
                sub_invokes: &[],
            },
        }]);
    }

    fn signer_of_last_call(&self) -> Address {
        let auths = self.env.auths();
        assert_eq!(auths.len(), 1);
        auths[0].0.clone()
    }

    fn set_status(&self, signer: &Address, node_id: &str, status: NodeStatus) -> Result<(), Error> {
        let env = self.env;
        match self.client.try_set_node_status_as(
            signer,
            &self.plan(),
            &s(env, node_id),
            &status,
            &s(env, "qdit"),
            &s(env, "qdit:testnet:C1:p1/m1@v1"),
        ) {
            Ok(_) => Ok(()),
            Err(Ok(e)) => Err(e),
            Err(Err(e)) => panic!("host error: {e:?}"),
        }
    }
}

// ---- assign_document -------------------------------------------------------

#[test]
fn assign_document_records_the_workspace() {
    let env = Env::default();
    let t = setup(&env);
    assert_eq!(t.client.get_doc_workspace(&t.plan()), Some(t.ws()));
    assert_eq!(t.client.get_doc_workspace(&s(&env, "other")), None);
    // The document keeps its owner.
    assert_eq!(t.client.get_document(&t.plan()).owner, t.author);
}

#[test]
fn assign_document_needs_the_document_owners_signature() {
    let env = Env::default();
    let t = setup(&env);
    let plan = t.plan();
    let ws = t.ws();

    t.client.assign_document(&plan, &ws);
    assert_eq!(t.signer_of_last_call(), t.author);

    // The workspace owner can't pull someone else's document in.
    t.only(&t.owner, "assign_document", (plan.clone(), ws.clone()));
    assert!(t.client.try_assign_document(&plan, &ws).is_err());
}

#[test]
fn any_member_may_assign_their_own_document() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    for (who, name) in [(&t.owner, "by-owner"), (&t.admin, "by-admin"), (&t.editor, "by-editor")] {
        let doc_id = s(&env, name);
        t.client.register_document(who, &doc_id, &hash(&env, 1));
        t.client.assign_document(&doc_id, &ws);
        assert_eq!(t.client.get_doc_workspace(&doc_id), Some(ws.clone()));
    }
}

#[test]
fn assign_document_refuses_non_members_and_missing_documents() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    let mine = s(&env, "strangers-doc");
    t.client.register_document(&t.stranger, &mine, &hash(&env, 1));
    assert_eq!(t.client.try_assign_document(&mine, &ws), Err(Ok(Error::NotEditor)));
    // The revoker is not a member either.
    let revokers = s(&env, "revokers-doc");
    t.client.register_document(&t.revoker, &revokers, &hash(&env, 1));
    assert_eq!(t.client.try_assign_document(&revokers, &ws), Err(Ok(Error::NotEditor)));
    assert_eq!(t.client.get_doc_workspace(&mine), None);

    assert_eq!(t.client.try_assign_document(&s(&env, "ghost"), &ws), Err(Ok(Error::DocumentNotFound)));
}

#[test]
fn assign_document_moves_a_document_between_workspaces() {
    let env = Env::default();
    let t = setup(&env);
    let other = s(&env, "ws-2");
    t.client.create_workspace(&other, &t.author);
    t.client.assign_document(&t.plan(), &other);
    assert_eq!(t.client.get_doc_workspace(&t.plan()), Some(other));
    // ws-1's editors lost the document with the move.
    assert_eq!(t.client.try_update_document_as(&t.editor, &t.plan(), &hash(&env, 2)), Err(Ok(Error::NotEditor)));
}

#[test]
fn assign_document_emits_the_document_and_workspace() {
    let env = Env::default();
    let t = setup(&env);
    t.client.assign_document(&t.plan(), &t.ws());
    let ev = env.events().all().last().unwrap();
    assert_eq!(Symbol::try_from_val(&env, &ev.1.get(1).unwrap()).unwrap(), symbol_short!("assign"));
    assert_eq!(<(String, String)>::try_from_val(&env, &ev.2).unwrap(), (t.plan(), t.ws()));
}

// ---- Writers ---------------------------------------------------------------

#[test]
fn members_update_the_document_with_their_own_signature() {
    let env = Env::default();
    let t = setup(&env);
    let plan = t.plan();
    let mut expected = 1;
    for (who, seed) in [(&t.editor, 2u8), (&t.admin, 3), (&t.owner, 4), (&t.author, 5)] {
        expected += 1;
        assert_eq!(t.client.update_document_as(who, &plan, &hash(&env, seed)), expected);
        assert_eq!(t.signer_of_last_call(), *who);
    }
    let doc = t.client.get_document(&plan);
    assert_eq!((doc.version, doc.content_hash), (5, hash(&env, 5)));
    assert_eq!(doc.owner, t.author);
}

#[test]
fn members_set_node_status_with_their_own_signature() {
    let env = Env::default();
    let t = setup(&env);
    t.set_status(&t.editor, "root", NodeStatus::Built).unwrap();
    assert_eq!(t.signer_of_last_call(), t.editor);
    t.set_status(&t.admin, "design", NodeStatus::Building).unwrap();
    t.set_status(&t.owner, "root", NodeStatus::Verified).unwrap();

    let root = t.client.get_node(&t.plan(), &s(&env, "root"));
    assert_eq!(root.status, NodeStatus::Verified);
    assert_eq!(root.tool, s(&env, "qdit"));
    assert_eq!(root.artifact_ref, s(&env, "qdit:testnet:C1:p1/m1@v1"));
    // "root" came from the author's anchor; only "design" is new.
    assert_eq!(t.client.get_document(&t.plan()).node_count, 2);
}

#[test]
fn members_anchor_with_their_own_signature() {
    let env = Env::default();
    let t = setup(&env);
    let plan = t.plan();

    let nodes = vec![&env, update(&env, "root", NodeStatus::Built), update(&env, "api", NodeStatus::Planned)];
    assert_eq!(t.client.anchor_as(&t.editor, &plan, &hash(&env, 2), &nodes), 2);
    assert_eq!(t.signer_of_last_call(), t.editor);
    // Same text: no new version.
    assert_eq!(t.client.anchor_as(&t.admin, &plan, &hash(&env, 2), &Vec::new(&env)), 2);

    let doc = t.client.get_document(&plan);
    assert_eq!((doc.version, doc.node_count, doc.owner), (2, 2, t.author.clone()));
    assert_eq!(t.client.get_node(&plan, &s(&env, "root")).status, NodeStatus::Built);
}

#[test]
fn anchor_as_registers_a_new_document_to_its_signer() {
    let env = Env::default();
    let t = setup(&env);
    let fresh = s(&env, "fresh");
    assert_eq!(t.client.anchor_as(&t.editor, &fresh, &hash(&env, 1), &vec![&env, update(&env, "root", NodeStatus::Planned)]), 1);
    let doc = t.client.get_document(&fresh);
    assert_eq!((doc.owner, doc.version, doc.node_count), (t.editor.clone(), 1, 1));
    // Not in any workspace until its owner assigns it.
    assert_eq!(t.client.get_doc_workspace(&fresh), None);
    assert_eq!(t.client.try_update_document_as(&t.admin, &fresh, &hash(&env, 2)), Err(Ok(Error::NotEditor)));
}

#[test]
fn the_document_owner_may_use_the_as_calls_without_a_workspace() {
    let env = Env::default();
    let t = setup(&env);
    let solo = s(&env, "solo");
    t.client.register_document(&t.stranger, &solo, &hash(&env, 1));
    assert_eq!(t.client.update_document_as(&t.stranger, &solo, &hash(&env, 2)), 2);
    t.client.set_node_status_as(&t.stranger, &solo, &s(&env, "n"), &NodeStatus::Built, &s(&env, "x"), &s(&env, "y"));
    assert_eq!(t.client.anchor_as(&t.stranger, &solo, &hash(&env, 3), &Vec::new(&env)), 3);
    assert_eq!(t.client.get_document(&solo).node_count, 1);
}

#[test]
fn non_members_cannot_write_a_workspace_document() {
    let env = Env::default();
    let t = setup(&env);
    let plan = t.plan();
    for who in [&t.stranger, &t.revoker] {
        assert_eq!(t.client.try_update_document_as(who, &plan, &hash(&env, 9)), Err(Ok(Error::NotEditor)));
        assert_eq!(t.set_status(who, "root", NodeStatus::Verified), Err(Error::NotEditor));
        assert_eq!(
            t.client.try_anchor_as(who, &plan, &hash(&env, 9), &vec![&env, update(&env, "x", NodeStatus::Built)]),
            Err(Ok(Error::NotEditor))
        );
    }
    let doc = t.client.get_document(&plan);
    assert_eq!((doc.version, doc.content_hash, doc.node_count), (1, hash(&env, 1), 1));
    assert_eq!(t.client.get_node(&plan, &s(&env, "root")).status, NodeStatus::Planned);
}

#[test]
fn members_cannot_write_a_document_outside_the_workspace() {
    let env = Env::default();
    let t = setup(&env);
    let private = s(&env, "private");
    t.client.register_document(&t.stranger, &private, &hash(&env, 1));
    for who in [&t.owner, &t.admin, &t.editor] {
        assert_eq!(t.client.try_update_document_as(who, &private, &hash(&env, 9)), Err(Ok(Error::NotEditor)));
    }
}

/// D-16: a member removed in the app loses chain access with the revoker's
/// one call, before any admin signs anything.
#[test]
fn a_removed_editor_is_refused_at_once() {
    let env = Env::default();
    let t = setup(&env);
    let plan = t.plan();
    assert_eq!(t.client.update_document_as(&t.editor, &plan, &hash(&env, 2)), 2);

    assert!(t.client.remove_editor(&t.ws(), &t.revoker, &t.editor));

    assert_eq!(t.client.try_update_document_as(&t.editor, &plan, &hash(&env, 3)), Err(Ok(Error::NotEditor)));
    assert_eq!(t.set_status(&t.editor, "root", NodeStatus::Built), Err(Error::NotEditor));
    assert_eq!(t.client.try_anchor_as(&t.editor, &plan, &hash(&env, 3), &Vec::new(&env)), Err(Ok(Error::NotEditor)));
    assert_eq!(t.client.get_document(&plan).version, 2);
}

#[test]
fn a_removed_admin_is_refused_at_once() {
    let env = Env::default();
    let t = setup(&env);
    assert!(t.client.remove_admin(&t.ws(), &t.owner, &t.admin));
    assert_eq!(t.client.try_update_document_as(&t.admin, &t.plan(), &hash(&env, 3)), Err(Ok(Error::NotEditor)));
    assert_eq!(t.client.try_add_editor(&t.ws(), &t.admin, &t.stranger), Err(Ok(Error::NotWorkspaceAdmin)));
}

#[test]
fn as_calls_on_a_missing_document() {
    let env = Env::default();
    let t = setup(&env);
    let ghost = s(&env, "ghost");
    assert_eq!(t.client.try_update_document_as(&t.editor, &ghost, &hash(&env, 1)), Err(Ok(Error::DocumentNotFound)));
    assert_eq!(
        t.client.try_set_node_status_as(&t.editor, &ghost, &s(&env, "n"), &NodeStatus::Built, &s(&env, "x"), &s(&env, "y")),
        Err(Ok(Error::DocumentNotFound))
    );
}

#[test]
fn anchor_as_refuses_too_many_nodes() {
    let env = Env::default();
    let t = setup(&env);
    let mut nodes = Vec::new(&env);
    for _ in 0..=MAX_NODES_PER_CALL {
        nodes.push_back(update(&env, "n", NodeStatus::Planned));
    }
    assert_eq!(t.client.try_anchor_as(&t.editor, &t.plan(), &hash(&env, 2), &nodes), Err(Ok(Error::TooManyNodes)));
    // Exactly the limit is fine.
    nodes.pop_back();
    assert_eq!(t.client.anchor_as(&t.editor, &t.plan(), &hash(&env, 2), &nodes), 2);
}

/// With no mocked signatures, the `*_as` calls are refused by the host,
/// and naming a member as signer doesn't help someone else who signed.
#[test]
fn as_calls_need_the_signers_own_signature() {
    let env = Env::default();
    let t = setup(&env);
    let plan = t.plan();
    env.set_auths(&[]);
    assert!(t.client.try_update_document_as(&t.editor, &plan, &hash(&env, 2)).is_err());
    assert!(t
        .client
        .try_set_node_status_as(&t.editor, &plan, &s(&env, "root"), &NodeStatus::Built, &s(&env, "x"), &s(&env, "y"))
        .is_err());
    assert!(t.client.try_anchor_as(&t.editor, &plan, &hash(&env, 2), &Vec::new(&env)).is_err());

    // The stranger signs a write that names the editor.
    t.only(&t.stranger, "update_document_as", (t.editor.clone(), plan.clone(), hash(&env, 2)));
    assert!(t.client.try_update_document_as(&t.editor, &plan, &hash(&env, 2)).is_err());
    // The document's owner signs, but the call names the editor.
    t.only(&t.author, "anchor_as", (t.editor.clone(), plan.clone(), hash(&env, 2), Vec::<NodeUpdate>::new(&env)));
    assert!(t.client.try_anchor_as(&t.editor, &plan, &hash(&env, 2), &Vec::new(&env)).is_err());

    assert_eq!(t.client.get_document(&plan).version, 1);
}

/// The `*_as` calls do not widen the original calls: those stay owner-only.
#[test]
fn the_owner_only_calls_still_refuse_editors() {
    let env = Env::default();
    let t = setup(&env);
    let plan = t.plan();

    assert_eq!(t.client.try_anchor(&t.editor, &plan, &hash(&env, 2), &Vec::new(&env)), Err(Ok(Error::NotOwner)));
    assert_eq!(t.client.try_anchor(&t.owner, &plan, &hash(&env, 2), &Vec::new(&env)), Err(Ok(Error::NotOwner)));

    // update_document / set_node_status ask the document's owner to sign;
    // the editor's signature is not enough.
    t.only(&t.editor, "update_document", (plan.clone(), hash(&env, 2)));
    assert!(t.client.try_update_document(&plan, &hash(&env, 2)).is_err());
    env.mock_all_auths();
    t.client.update_document(&plan, &hash(&env, 2));
    assert_eq!(t.signer_of_last_call(), t.author);
    t.client.set_node_status(&plan, &s(&env, "root"), &NodeStatus::Built, &s(&env, "x"), &s(&env, "y"));
    assert_eq!(t.signer_of_last_call(), t.author);
}

/// The `*_as` calls emit the same register / update / node events as the
/// owner-only calls, with the signer added as a third topic.
#[test]
fn as_events_carry_the_signer() {
    let env = Env::default();
    let t = setup(&env);
    let plan = t.plan();

    let events = |env: &Env, doc_id: &String| -> std::vec::Vec<(Symbol, Address)> {
        env.events()
            .all()
            .iter()
            .map(|ev| {
                assert_eq!(ev.1.len(), 3);
                assert_eq!(Symbol::try_from_val(env, &ev.1.get(0).unwrap()).unwrap(), symbol_short!("doqtri"));
                assert_eq!(String::try_from_val(env, &ev.2).unwrap(), *doc_id);
                (
                    Symbol::try_from_val(env, &ev.1.get(1).unwrap()).unwrap(),
                    Address::try_from_val(env, &ev.1.get(2).unwrap()).unwrap(),
                )
            })
            .collect()
    };

    t.client.update_document_as(&t.editor, &plan, &hash(&env, 2));
    assert_eq!(events(&env, &plan), [(symbol_short!("update"), t.editor.clone())]);

    t.set_status(&t.admin, "root", NodeStatus::Built).unwrap();
    assert_eq!(events(&env, &plan), [(symbol_short!("node"), t.admin.clone())]);

    t.client.anchor_as(&t.owner, &plan, &hash(&env, 3), &vec![&env, update(&env, "root", NodeStatus::Verified)]);
    assert_eq!(
        events(&env, &plan),
        [(symbol_short!("update"), t.owner.clone()), (symbol_short!("node"), t.owner.clone())]
    );

    let fresh = s(&env, "fresh");
    t.client.anchor_as(&t.editor, &fresh, &hash(&env, 1), &Vec::new(&env));
    assert_eq!(events(&env, &fresh), [(symbol_short!("register"), t.editor.clone())]);
}
