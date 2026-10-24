#![cfg(test)]
//! Tests for `assign_document` and the `*_as` calls: workspace members
//! writing a document with their own signature, and everyone else refused.

extern crate std;

use super::*;
use soroban_sdk::testutils::storage::Persistent as _;
use soroban_sdk::testutils::{Address as _, Events, Ledger as _, MockAuth, MockAuthInvoke};
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
    /// An editor who anchored `plan` and put it in the workspace, which
    /// handed it to the workspace's owner.
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
    t.client.set_revoker(&t.revoker);
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
}

/// D-16: a document in a workspace belongs to the workspace's owner, so its
/// author writes it as a member and loses it when removed.
#[test]
fn assign_document_hands_the_document_to_the_workspace_owner() {
    let env = Env::default();
    let t = setup(&env);
    let doc = t.client.get_document(&t.plan());
    assert_eq!(doc.owner, t.owner);
    // Nothing else about it changed.
    assert_eq!((doc.content_hash, doc.version, doc.node_count), (hash(&env, 1), 1, 1));
    assert_eq!(t.client.get_node(&t.plan(), &s(&env, "root")).status, NodeStatus::Planned);
}

#[test]
fn assign_document_needs_the_document_owners_signature() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    let draft = s(&env, "draft");
    t.client.register_document(&t.editor, &draft, &hash(&env, 1));

    // The workspace owner can't pull someone else's document in.
    t.only(&t.owner, "assign_document", (draft.clone(), ws.clone()));
    assert!(t.client.try_assign_document(&draft, &ws).is_err());
    assert_eq!(t.client.get_doc_workspace(&draft), None);

    env.mock_all_auths();
    t.client.assign_document(&draft, &ws);
    assert_eq!(t.signer_of_last_call(), t.editor);
    // Assigned, it is the workspace owner's, and assigning it again asks them.
    t.client.assign_document(&draft, &ws);
    assert_eq!(t.signer_of_last_call(), t.owner);
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
        assert_eq!(t.client.get_document(&doc_id).owner, t.owner);
        // The author keeps writing it, now as a member.
        assert_eq!(t.client.update_document_as(who, &doc_id, &hash(&env, 2)), 2);
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
    assert_eq!(t.client.get_document(&mine).owner, t.stranger);

    assert_eq!(t.client.try_assign_document(&s(&env, "ghost"), &ws), Err(Ok(Error::DocumentNotFound)));
}

/// Only the workspace's owner, who owns its documents, can move one out;
/// its author can't take it to a workspace of their own.
#[test]
fn a_member_cannot_move_a_document_out_of_the_workspace() {
    let env = Env::default();
    let t = setup(&env);
    let plan = t.plan();
    let theirs = s(&env, "ws-2");
    t.client.create_workspace(&theirs, &t.author);

    for who in [&t.author, &t.admin, &t.editor] {
        t.only(who, "assign_document", (plan.clone(), theirs.clone()));
        assert!(t.client.try_assign_document(&plan, &theirs).is_err());
        t.only(who, "unassign_document", (plan.clone(),));
        assert!(t.client.try_unassign_document(&plan).is_err());
    }
    env.mock_all_auths();
    assert_eq!(t.client.get_doc_workspace(&plan), Some(t.ws()));
    assert_eq!(t.client.get_document(&plan).owner, t.owner);
    // And the team still writes it.
    assert_eq!(t.client.update_document_as(&t.editor, &plan, &hash(&env, 2)), 2);
}

#[test]
fn assign_document_moves_a_document_between_workspaces() {
    let env = Env::default();
    let t = setup(&env);
    let other = s(&env, "ws-2");
    t.client.create_workspace(&other, &t.author);
    // The document's owner, ws-1's owner, must be a member of ws-2 to move it there.
    assert_eq!(t.client.try_assign_document(&t.plan(), &other), Err(Ok(Error::NotEditor)));
    t.client.add_editor(&other, &t.author, &t.owner);

    t.client.assign_document(&t.plan(), &other);
    assert_eq!(t.signer_of_last_call(), t.owner);
    assert_eq!(t.client.get_doc_workspace(&t.plan()), Some(other));
    assert_eq!(t.client.get_document(&t.plan()).owner, t.author);
    // ws-1's editors lost the document with the move.
    assert_eq!(t.client.try_update_document_as(&t.editor, &t.plan(), &hash(&env, 2)), Err(Ok(Error::NotEditor)));
}

#[test]
fn assign_document_emits_the_document_workspace_and_owner() {
    let env = Env::default();
    let t = setup(&env);
    t.client.assign_document(&t.plan(), &t.ws());
    let ev = env.events().all().last().unwrap();
    assert_eq!(Symbol::try_from_val(&env, &ev.1.get(0).unwrap()).unwrap(), symbol_short!("doqtri_ws"));
    assert_eq!(Symbol::try_from_val(&env, &ev.1.get(1).unwrap()).unwrap(), symbol_short!("assign"));
    assert_eq!(
        <(String, String, Address)>::try_from_val(&env, &ev.2).unwrap(),
        (t.plan(), t.ws(), t.owner.clone())
    );
}

// ---- unassign_document -----------------------------------------------------

#[test]
fn the_owner_unassigns_a_document() {
    let env = Env::default();
    let t = setup(&env);
    let plan = t.plan();
    assert!(t.client.unassign_document(&plan));
    assert_eq!(t.signer_of_last_call(), t.owner);
    let ev = env.events().all().last().unwrap();
    assert_eq!(Symbol::try_from_val(&env, &ev.1.get(0).unwrap()).unwrap(), symbol_short!("doqtri_ws"));
    assert_eq!(Symbol::try_from_val(&env, &ev.1.get(1).unwrap()).unwrap(), symbol_short!("unassign"));
    assert_eq!(<(String, String)>::try_from_val(&env, &ev.2).unwrap(), (plan.clone(), t.ws()));

    assert_eq!(t.client.get_doc_workspace(&plan), None);
    assert_eq!(t.client.get_document(&plan).owner, t.owner);
    for who in [&t.admin, &t.editor, &t.author] {
        assert_eq!(t.client.try_update_document_as(who, &plan, &hash(&env, 2)), Err(Ok(Error::NotEditor)));
    }
    assert_eq!(t.client.update_document_as(&t.owner, &plan, &hash(&env, 2)), 2);
    // Again: nothing to do, still succeeds.
    assert!(!t.client.unassign_document(&plan));
    assert_eq!(t.client.try_unassign_document(&s(&env, "ghost")), Err(Ok(Error::DocumentNotFound)));
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
    assert_eq!(doc.owner, t.owner);
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
    assert_eq!((doc.version, doc.node_count, doc.owner), (2, 2, t.owner.clone()));
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

/// The review's D-16 gap: the member who wrote a document and put it in
/// the workspace loses it too when removed, through every write call.
#[test]
fn a_removed_author_loses_the_document_they_wrote() {
    let env = Env::default();
    let t = setup(&env);
    let plan = t.plan();
    assert!(t.client.remove_editor(&t.ws(), &t.revoker, &t.author));

    assert_eq!(t.client.try_update_document_as(&t.author, &plan, &hash(&env, 3)), Err(Ok(Error::NotEditor)));
    assert_eq!(t.set_status(&t.author, "root", NodeStatus::Built), Err(Error::NotEditor));
    assert_eq!(t.client.try_anchor_as(&t.author, &plan, &hash(&env, 3), &Vec::new(&env)), Err(Ok(Error::NotEditor)));
    // The owner-only calls are no way back in: the author is not the owner.
    assert_eq!(t.client.try_anchor(&t.author, &plan, &hash(&env, 3), &Vec::new(&env)), Err(Ok(Error::NotOwner)));
    t.only(&t.author, "update_document", (plan.clone(), hash(&env, 3)));
    assert!(t.client.try_update_document(&plan, &hash(&env, 3)).is_err());
    t.only(&t.author, "assign_document", (plan.clone(), t.ws()));
    assert!(t.client.try_assign_document(&plan, &t.ws()).is_err());

    env.mock_all_auths();
    let doc = t.client.get_document(&plan);
    assert_eq!((doc.version, doc.owner), (1, t.owner.clone()));
    assert_eq!(t.client.get_node(&plan, &s(&env, "root")).status, NodeStatus::Planned);
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
fn an_admin_removed_by_the_revoker_is_refused_at_once() {
    let env = Env::default();
    let t = setup(&env);
    assert!(t.client.remove_admin(&t.ws(), &t.revoker, &t.admin));
    assert_eq!(t.client.try_update_document_as(&t.admin, &t.plan(), &hash(&env, 3)), Err(Ok(Error::NotEditor)));
    assert_eq!(t.client.try_add_editor(&t.ws(), &t.admin, &t.stranger), Err(Ok(Error::NotWorkspaceAdmin)));
    assert_eq!(t.client.try_remove_editor(&t.ws(), &t.admin, &t.editor), Err(Ok(Error::NotWorkspaceAdmin)));
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
    t.only(&t.owner, "anchor_as", (t.editor.clone(), plan.clone(), hash(&env, 2), Vec::<NodeUpdate>::new(&env)));
    assert!(t.client.try_anchor_as(&t.editor, &plan, &hash(&env, 2), &Vec::new(&env)).is_err());

    assert_eq!(t.client.get_document(&plan).version, 1);
}

/// The `*_as` calls do not widen the original calls: those stay owner-only,
/// and the owner of a workspace document is the workspace's owner.
#[test]
fn the_owner_only_calls_still_refuse_editors() {
    let env = Env::default();
    let t = setup(&env);
    let plan = t.plan();

    for who in [&t.editor, &t.admin, &t.author] {
        assert_eq!(t.client.try_anchor(who, &plan, &hash(&env, 2), &Vec::new(&env)), Err(Ok(Error::NotOwner)));
    }
    assert_eq!(t.client.anchor(&t.owner, &plan, &hash(&env, 2), &Vec::new(&env)), 2);

    // update_document / set_node_status ask the document's owner to sign;
    // an editor's signature is not enough.
    t.only(&t.editor, "update_document", (plan.clone(), hash(&env, 3)));
    assert!(t.client.try_update_document(&plan, &hash(&env, 3)).is_err());
    env.mock_all_auths();
    t.client.update_document(&plan, &hash(&env, 3));
    assert_eq!(t.signer_of_last_call(), t.owner);
    t.client.set_node_status(&plan, &s(&env, "root"), &NodeStatus::Built, &s(&env, "x"), &s(&env, "y"));
    assert_eq!(t.signer_of_last_call(), t.owner);
}

/// A document written only by its owner, through the owner-only calls that
/// never read the workspace, still keeps its workspace entries alive, so a
/// member's write or the revoker's removal never finds them archived.
#[test]
fn writing_a_document_keeps_its_workspace_alive() {
    let env = Env::default();
    let t = setup(&env);
    let plan = t.plan();
    let ttls = || {
        env.as_contract(&t.client.address, || {
            let store = env.storage().persistent();
            (
                store.get_ttl(&DataKey::DocWorkspace(plan.clone())),
                store.get_ttl(&DataKey::Workspace(t.ws())),
            )
        })
    };
    let full = 90 * 17280;
    assert_eq!(ttls(), (full, full));
    // Keep the contract itself alive across the jumps below; on the network
    // its code and instance are extended separately.
    env.as_contract(&t.client.address, || env.storage().instance().extend_ttl(200 * 17280, 200 * 17280));

    // Sixty days on, past the 30-day threshold.
    let later = 60 * 17280;
    env.ledger().with_mut(|l| l.sequence_number += later);
    assert_eq!(ttls(), (full - later, full - later));
    t.client.anchor(&t.owner, &plan, &hash(&env, 2), &Vec::new(&env));
    assert_eq!(ttls(), (full, full));

    env.ledger().with_mut(|l| l.sequence_number += later);
    t.client.update_document(&plan, &hash(&env, 3));
    assert_eq!(ttls(), (full, full));

    env.ledger().with_mut(|l| l.sequence_number += later);
    // A node the ledger has not archived ("root" was last written 180 days ago).
    t.client.set_node_status(&plan, &s(&env, "late"), &NodeStatus::Built, &s(&env, "x"), &s(&env, "y"));
    assert_eq!(ttls(), (full, full));
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
