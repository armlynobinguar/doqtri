#![cfg(test)]
//! Tests for workspace ownership changes (D-29) and for documents
//! following the workspace's current owner (D-28).

extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Events, MockAuth, MockAuthInvoke};
use soroban_sdk::{symbol_short, vec, Address, BytesN, Env, IntoVal, String, Symbol, TryFromVal, Val, Vec};

struct Setup<'a> {
    env: &'a Env,
    client: DoqtriRegistryClient<'a>,
    /// May upgrade the contract, set the revoker and reassign owners.
    contract_admin: Address,
    /// Owns the workspace, so `plan` and `own`, and owns `solo` outright.
    owner: Address,
    admin: Address,
    editor: Address,
    /// An editor who anchored `plan` and assigned it to the workspace.
    author: Address,
    revoker: Address,
    stranger: Address,
    /// Whom the workspace is handed to.
    heir: Address,
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

/// Workspace `ws-1` (an admin, an editor, the author as a second editor),
/// the revoker, and three documents: `plan` (the author's, assigned),
/// `own` (the owner's, assigned) and `solo` (the owner's, in no
/// workspace). Every auth is mocked.
fn setup(env: &Env) -> Setup<'_> {
    env.mock_all_auths();
    let contract_admin = Address::generate(env);
    let contract_id = env.register(DoqtriRegistry, (contract_admin.clone(),));
    let t = Setup {
        env,
        client: DoqtriRegistryClient::new(env, &contract_id),
        contract_admin,
        owner: Address::generate(env),
        admin: Address::generate(env),
        editor: Address::generate(env),
        author: Address::generate(env),
        revoker: Address::generate(env),
        stranger: Address::generate(env),
        heir: Address::generate(env),
    };
    let ws = t.ws();
    t.client.create_workspace(&ws, &t.owner);
    t.client.add_admin(&ws, &t.owner, &t.admin);
    t.client.add_editor(&ws, &t.admin, &t.editor);
    t.client.add_editor(&ws, &t.admin, &t.author);
    t.client.set_revoker(&t.revoker);
    let root = vec![env, update(env, "root", NodeStatus::Planned)];
    t.client.anchor(&t.author, &t.plan(), &hash(env, 1), &root);
    t.client.assign_document(&t.plan(), &ws);
    t.client.anchor(&t.owner, &s(env, "own"), &hash(env, 1), &root);
    t.client.assign_document(&s(env, "own"), &ws);
    t.client.anchor(&t.owner, &s(env, "solo"), &hash(env, 1), &root);
    t
}

impl Setup<'_> {
    fn ws(&self) -> String {
        s(self.env, "ws-1")
    }

    fn plan(&self) -> String {
        s(self.env, "plan")
    }

    /// Allows exactly `signers` to sign the next call, to `fn_name` with `args`.
    fn signed_by<A: IntoVal<Env, Vec<Val>> + Clone>(&self, signers: &[&Address], fn_name: &str, args: A) {
        let args: Vec<Val> = args.into_val(self.env);
        let invoke = MockAuthInvoke {
            contract: &self.client.address,
            fn_name,
            args: args.clone(),
            sub_invokes: &[],
        };
        let auths: std::vec::Vec<MockAuth> = signers
            .iter()
            .map(|address| MockAuth { address, invoke: &invoke })
            .collect();
        self.env.mock_auths(&auths);
    }

    /// The `transfer_workspace` of `ws-1` from `from` to `to`, with only
    /// `signers` signing. True when it went through.
    fn transfer(&self, from: &Address, to: &Address, signers: &[&Address]) -> bool {
        let ws = self.ws();
        self.signed_by(signers, "transfer_workspace", (ws.clone(), from.clone(), to.clone()));
        let ok = self.client.try_transfer_workspace(&ws, from, to).is_ok();
        self.env.mock_all_auths();
        ok
    }

    /// The addresses whose signatures the last call asked for.
    fn signers_of_last_call(&self) -> std::vec::Vec<Address> {
        self.env.auths().into_iter().map(|a| a.0).collect()
    }

    fn signer_of_last_call(&self) -> Address {
        let signers = self.signers_of_last_call();
        assert_eq!(signers.len(), 1);
        signers[0].clone()
    }

    /// The `owner` field as stored, without the workspace resolution.
    fn stored_owner(&self, doc_id: &String) -> Address {
        self.env.as_contract(&self.client.address, || {
            let doc: Document = self.env.storage().persistent().get(&DataKey::Doc(doc_id.clone())).unwrap();
            doc.owner
        })
    }
}

// ---- transfer_workspace: who may ---------------------------------------------

#[test]
fn a_transfer_needs_both_owners_signatures() {
    let env = Env::default();
    let t = setup(&env);

    assert!(!t.transfer(&t.owner, &t.heir, &[]));
    assert!(!t.transfer(&t.owner, &t.heir, &[&t.owner]));
    assert!(!t.transfer(&t.owner, &t.heir, &[&t.heir]));
    // The revoker or the contract admin can't stand in for either side.
    assert!(!t.transfer(&t.owner, &t.heir, &[&t.owner, &t.revoker]));
    assert!(!t.transfer(&t.owner, &t.heir, &[&t.contract_admin, &t.heir]));
    assert_eq!(t.client.get_workspace(&t.ws()).owner, t.owner);

    assert!(t.transfer(&t.owner, &t.heir, &[&t.owner, &t.heir]));
    assert_eq!(t.client.get_workspace(&t.ws()).owner, t.heir);
}

#[test]
fn a_transfer_asks_for_exactly_the_two_owners() {
    let env = Env::default();
    let t = setup(&env);
    t.client.transfer_workspace(&t.ws(), &t.owner, &t.heir);
    let mut signers = t.signers_of_last_call();
    signers.sort();
    let mut expected = std::vec![t.owner.clone(), t.heir.clone()];
    expected.sort();
    assert_eq!(signers, expected);
}

/// Only the stored owner may hand the workspace on; naming yourself as
/// `owner` and signing is not enough. The revoker in particular can only
/// remove members.
#[test]
fn only_the_owner_transfers() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    for who in [&t.admin, &t.editor, &t.author, &t.revoker, &t.contract_admin, &t.stranger, &t.heir] {
        assert_eq!(
            t.client.try_transfer_workspace(&ws, who, &t.heir),
            Err(Ok(Error::NotWorkspaceOwner)),
        );
        // Not even to themselves.
        assert_eq!(
            t.client.try_transfer_workspace(&ws, who, who),
            Err(Ok(Error::NotWorkspaceOwner)),
        );
    }
    assert_eq!(
        t.client.try_transfer_workspace(&s(&env, "ghost"), &t.owner, &t.heir),
        Err(Ok(Error::WorkspaceNotFound)),
    );
    assert_eq!(t.client.get_workspace(&ws).owner, t.owner);
}

// ---- transfer_workspace: what moves ------------------------------------------

#[test]
fn a_transfer_moves_the_workspace_and_its_documents() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    t.client.transfer_workspace(&ws, &t.owner, &t.heir);

    let after = t.client.get_workspace(&ws);
    assert_eq!(after.owner, t.heir);
    assert!(t.client.is_editor(&ws, &t.heir));
    assert!(!t.client.is_editor(&ws, &t.owner));
    assert_eq!(t.client.get_role(&ws, &t.owner), None);
    assert_eq!(t.client.get_role(&ws, &t.heir), None);
    // The members stay.
    assert_eq!(after.members.len(), 3);
    assert_eq!(t.client.get_role(&ws, &t.admin), Some(Role::Admin));
    assert_eq!(t.client.get_role(&ws, &t.editor), Some(Role::Editor));

    // Both workspace documents now read as the heir's, whoever wrote them;
    // the owner's document outside the workspace stays theirs.
    assert_eq!(t.client.get_document(&t.plan()).owner, t.heir);
    assert_eq!(t.client.get_document(&s(&env, "own")).owner, t.heir);
    assert_eq!(t.client.get_document(&s(&env, "solo")).owner, t.owner);
}

/// D-18: the transfer rewrites no document. The stored record keeps its
/// old owner until its next write, which stores the current one.
#[test]
fn the_stored_record_catches_up_on_its_next_write() {
    let env = Env::default();
    let t = setup(&env);
    let plan = t.plan();
    t.client.transfer_workspace(&t.ws(), &t.owner, &t.heir);
    assert_eq!(t.stored_owner(&plan), t.owner);
    assert_eq!(t.client.get_document(&plan).owner, t.heir);

    t.client.update_document_as(&t.editor, &plan, &hash(&env, 2));
    assert_eq!(t.stored_owner(&plan), t.heir);

    // The owner-only calls store it too.
    let own = s(&env, "own");
    assert_eq!(t.stored_owner(&own), t.owner);
    t.client.update_document(&own, &hash(&env, 2));
    assert_eq!(t.stored_owner(&own), t.heir);
}

#[test]
fn the_former_owner_loses_every_owner_power() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    let plan = t.plan();
    let newcomer = Address::generate(&env);
    t.client.transfer_workspace(&ws, &t.owner, &t.heir);

    // Workspace management, with every signature mocked.
    assert_eq!(t.client.try_add_admin(&ws, &t.owner, &newcomer), Err(Ok(Error::NotWorkspaceOwner)));
    assert_eq!(t.client.try_remove_admin(&ws, &t.owner, &t.admin), Err(Ok(Error::NotWorkspaceOwner)));
    assert_eq!(t.client.try_add_editor(&ws, &t.owner, &newcomer), Err(Ok(Error::NotWorkspaceAdmin)));
    assert_eq!(t.client.try_remove_editor(&ws, &t.owner, &t.editor), Err(Ok(Error::NotWorkspaceAdmin)));
    assert_eq!(t.client.try_transfer_workspace(&ws, &t.owner, &newcomer), Err(Ok(Error::NotWorkspaceOwner)));

    // Writes: the stored owner field no longer lets them in.
    for doc_id in [plan.clone(), s(&env, "own")] {
        assert_eq!(t.client.try_anchor(&t.owner, &doc_id, &hash(&env, 2), &Vec::new(&env)), Err(Ok(Error::NotOwner)));
        assert_eq!(t.client.try_update_document_as(&t.owner, &doc_id, &hash(&env, 2)), Err(Ok(Error::NotEditor)));
        assert_eq!(
            t.client.try_set_node_status_as(&t.owner, &doc_id, &s(&env, "root"), &NodeStatus::Built, &s(&env, "x"), &s(&env, "y")),
            Err(Ok(Error::NotEditor)),
        );
        assert_eq!(t.client.try_anchor_as(&t.owner, &doc_id, &hash(&env, 2), &Vec::new(&env)), Err(Ok(Error::NotEditor)));
    }

    // The calls that name no signer ask the heir; the former owner's
    // signature does not do.
    t.signed_by(&[&t.owner], "update_document", (plan.clone(), hash(&env, 2)));
    assert!(t.client.try_update_document(&plan, &hash(&env, 2)).is_err());
    let status_args = (plan.clone(), s(&env, "root"), NodeStatus::Built, s(&env, "x"), s(&env, "y"));
    t.signed_by(&[&t.owner], "set_node_status", status_args);
    assert!(t.client.try_set_node_status(&plan, &s(&env, "root"), &NodeStatus::Built, &s(&env, "x"), &s(&env, "y")).is_err());
    t.signed_by(&[&t.owner], "unassign_document", (plan.clone(),));
    assert!(t.client.try_unassign_document(&plan).is_err());
    env.mock_all_auths();
    t.client.create_workspace(&s(&env, "ws-2"), &t.owner);
    t.signed_by(&[&t.owner], "assign_document", (plan.clone(), s(&env, "ws-2")));
    assert!(t.client.try_assign_document(&plan, &s(&env, "ws-2")).is_err());

    env.mock_all_auths();
    assert_eq!(t.client.get_doc_workspace(&plan), Some(ws));
    assert_eq!(t.client.get_document(&plan).version, 1);
    assert_eq!(t.client.get_node(&plan, &s(&env, "root")).status, NodeStatus::Planned);
    // Their own document outside the workspace is untouched.
    t.signed_by(&[&t.owner], "update_document", (s(&env, "solo"), hash(&env, 2)));
    assert_eq!(t.client.update_document(&s(&env, "solo"), &hash(&env, 2)), 2);
}

#[test]
fn the_new_owner_gains_every_owner_power() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    let plan = t.plan();
    let newcomer = Address::generate(&env);
    t.client.transfer_workspace(&ws, &t.owner, &t.heir);

    // The owner-only calls, signed by the heir alone.
    t.signed_by(&[&t.heir], "update_document", (plan.clone(), hash(&env, 2)));
    assert_eq!(t.client.update_document(&plan, &hash(&env, 2)), 2);
    t.signed_by(&[&t.heir], "set_node_status", (plan.clone(), s(&env, "root"), NodeStatus::Built, s(&env, "x"), s(&env, "y")));
    t.client.set_node_status(&plan, &s(&env, "root"), &NodeStatus::Built, &s(&env, "x"), &s(&env, "y"));
    env.mock_all_auths();
    assert_eq!(t.client.anchor(&t.heir, &plan, &hash(&env, 3), &Vec::new(&env)), 3);
    assert_eq!(t.signer_of_last_call(), t.heir);
    assert_eq!(t.client.anchor_as(&t.heir, &s(&env, "own"), &hash(&env, 2), &Vec::new(&env)), 2);
    assert_eq!(t.client.get_node(&plan, &s(&env, "root")).status, NodeStatus::Built);

    // Workspace management.
    t.client.add_admin(&ws, &t.heir, &newcomer);
    assert_eq!(t.client.get_role(&ws, &newcomer), Some(Role::Admin));
    assert!(t.client.remove_admin(&ws, &t.heir, &newcomer));
    assert!(t.client.remove_editor(&ws, &t.heir, &t.editor));
    t.client.add_editor(&ws, &t.heir, &newcomer);
    assert_eq!(t.client.get_role(&ws, &newcomer), Some(Role::Editor));
    // ... the former owner back, as an admin.
    t.client.add_admin(&ws, &t.heir, &t.owner);
    assert_eq!(t.client.get_role(&ws, &t.owner), Some(Role::Admin));
    assert_eq!(t.client.update_document_as(&t.owner, &plan, &hash(&env, 4)), 4);
}

#[test]
fn members_keep_writing_after_a_transfer() {
    let env = Env::default();
    let t = setup(&env);
    let plan = t.plan();
    t.client.transfer_workspace(&t.ws(), &t.owner, &t.heir);

    assert_eq!(t.client.update_document_as(&t.editor, &plan, &hash(&env, 2)), 2);
    assert_eq!(t.client.anchor_as(&t.author, &plan, &hash(&env, 3), &vec![&env, update(&env, "api", NodeStatus::Building)]), 3);
    t.client.set_node_status_as(&t.admin, &plan, &s(&env, "root"), &NodeStatus::Built, &s(&env, "x"), &s(&env, "y"));
    assert_eq!(t.client.get_document(&plan).node_count, 2);
    // And the revoker still removes them at once.
    assert!(t.client.remove_editor(&t.ws(), &t.revoker, &t.editor));
    assert_eq!(t.client.try_update_document_as(&t.editor, &plan, &hash(&env, 4)), Err(Ok(Error::NotEditor)));
}

/// With no workspace left to resolve from, the stored owner is the owner,
/// so unassigning stores the current one; the former owner must not get
/// the document back.
#[test]
fn unassigning_after_a_transfer_leaves_the_document_with_the_new_owner() {
    let env = Env::default();
    let t = setup(&env);
    let plan = t.plan();
    t.client.transfer_workspace(&t.ws(), &t.owner, &t.heir);

    assert!(t.client.unassign_document(&plan));
    assert_eq!(t.signer_of_last_call(), t.heir);
    assert_eq!(t.client.get_doc_workspace(&plan), None);
    assert_eq!(t.stored_owner(&plan), t.heir);
    assert_eq!(t.client.get_document(&plan).owner, t.heir);

    assert_eq!(t.client.try_anchor(&t.owner, &plan, &hash(&env, 2), &Vec::new(&env)), Err(Ok(Error::NotOwner)));
    assert_eq!(t.client.try_update_document_as(&t.owner, &plan, &hash(&env, 2)), Err(Ok(Error::NotEditor)));
    assert_eq!(t.client.try_update_document_as(&t.editor, &plan, &hash(&env, 2)), Err(Ok(Error::NotEditor)));
    t.client.update_document(&plan, &hash(&env, 2));
    assert_eq!(t.signer_of_last_call(), t.heir);
}

#[test]
fn moving_a_document_after_a_transfer_needs_the_new_owner() {
    let env = Env::default();
    let t = setup(&env);
    let plan = t.plan();
    t.client.transfer_workspace(&t.ws(), &t.owner, &t.heir);
    let other = s(&env, "ws-2");
    t.client.create_workspace(&other, &t.stranger);

    // The heir must be a member of the destination.
    assert_eq!(t.client.try_assign_document(&plan, &other), Err(Ok(Error::NotEditor)));
    t.client.add_editor(&other, &t.stranger, &t.heir);
    t.signed_by(&[&t.heir], "assign_document", (plan.clone(), other.clone()));
    t.client.assign_document(&plan, &other);
    env.mock_all_auths();

    assert_eq!(t.client.get_doc_workspace(&plan), Some(other));
    assert_eq!(t.client.get_document(&plan).owner, t.stranger);
    assert_eq!(t.stored_owner(&plan), t.stranger);
    assert_eq!(t.client.try_update_document_as(&t.editor, &plan, &hash(&env, 2)), Err(Ok(Error::NotEditor)));
}

#[test]
fn a_member_who_becomes_owner_leaves_the_member_list() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    assert!(t.transfer(&t.owner, &t.admin, &[&t.owner, &t.admin]));

    let after = t.client.get_workspace(&ws);
    assert_eq!(after.owner, t.admin);
    assert!(!after.members.contains_key(t.admin.clone()));
    assert_eq!(after.members.len(), 2);
    assert_eq!(t.client.get_role(&ws, &t.admin), None);
    assert!(t.client.is_editor(&ws, &t.admin));
    // The owner is never a member role, so the revoker can't remove them.
    assert_eq!(t.client.try_remove_admin(&ws, &t.revoker, &t.admin), Err(Ok(Error::TargetIsOwner)));
    assert_eq!(t.client.try_remove_editor(&ws, &t.revoker, &t.admin), Err(Ok(Error::TargetIsOwner)));
}

#[test]
fn a_transfer_to_the_current_owner_changes_nothing() {
    let env = Env::default();
    let t = setup(&env);
    let before = t.client.get_workspace(&t.ws());
    t.client.transfer_workspace(&t.ws(), &t.owner, &t.owner);
    assert_eq!(env.events().all().len(), 0);
    assert_eq!(t.client.get_workspace(&t.ws()), before);
}

#[test]
fn a_workspace_can_be_handed_back() {
    let env = Env::default();
    let t = setup(&env);
    let plan = t.plan();
    t.client.transfer_workspace(&t.ws(), &t.owner, &t.heir);
    t.client.update_document(&plan, &hash(&env, 2));
    t.client.transfer_workspace(&t.ws(), &t.heir, &t.owner);

    assert_eq!(t.client.get_document(&plan).owner, t.owner);
    assert_eq!(t.client.try_anchor(&t.heir, &plan, &hash(&env, 3), &Vec::new(&env)), Err(Ok(Error::NotOwner)));
    assert_eq!(t.client.anchor(&t.owner, &plan, &hash(&env, 3), &Vec::new(&env)), 3);
}

// ---- admin_reassign_owner ------------------------------------------------------

#[test]
fn only_the_contract_admin_reassigns_an_owner() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();

    env.set_auths(&[]);
    assert!(t.client.try_admin_reassign_owner(&ws, &t.heir).is_err());
    for who in [&t.owner, &t.admin, &t.revoker, &t.heir, &t.stranger] {
        t.signed_by(&[who], "admin_reassign_owner", (ws.clone(), t.heir.clone()));
        assert!(t.client.try_admin_reassign_owner(&ws, &t.heir).is_err());
    }
    env.mock_all_auths();
    assert_eq!(t.client.get_workspace(&ws).owner, t.owner);

    t.signed_by(&[&t.contract_admin], "admin_reassign_owner", (ws.clone(), t.heir.clone()));
    t.client.admin_reassign_owner(&ws, &t.heir);
    assert_eq!(t.signer_of_last_call(), t.contract_admin);
    env.mock_all_auths();
    assert_eq!(t.client.get_workspace(&ws).owner, t.heir);

    assert_eq!(
        t.client.try_admin_reassign_owner(&s(&env, "ghost"), &t.heir),
        Err(Ok(Error::WorkspaceNotFound)),
    );
}

/// Recovery moves the same powers a transfer does, without the former
/// owner's signature.
#[test]
fn recovery_moves_owner_power_like_a_transfer() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    let plan = t.plan();
    // The admin is promoted (D-31's longest-standing admin).
    t.client.admin_reassign_owner(&ws, &t.admin);

    let after = t.client.get_workspace(&ws);
    assert_eq!(after.owner, t.admin);
    assert!(!after.members.contains_key(t.admin.clone()));
    assert_eq!(t.client.get_document(&plan).owner, t.admin);

    assert_eq!(t.client.try_anchor(&t.owner, &plan, &hash(&env, 2), &Vec::new(&env)), Err(Ok(Error::NotOwner)));
    assert_eq!(t.client.try_update_document_as(&t.owner, &plan, &hash(&env, 2)), Err(Ok(Error::NotEditor)));
    assert_eq!(t.client.try_add_admin(&ws, &t.owner, &t.stranger), Err(Ok(Error::NotWorkspaceOwner)));
    assert_eq!(t.client.try_transfer_workspace(&ws, &t.owner, &t.heir), Err(Ok(Error::NotWorkspaceOwner)));

    t.client.update_document(&plan, &hash(&env, 2));
    assert_eq!(t.signer_of_last_call(), t.admin);
    t.client.add_admin(&ws, &t.admin, &t.stranger);
    // And the recovered owner can hand it on as usual.
    assert!(t.transfer(&t.admin, &t.heir, &[&t.admin, &t.heir]));
    assert_eq!(t.client.get_document(&plan).owner, t.heir);
}

// ---- Events --------------------------------------------------------------------

#[test]
fn ownership_events_carry_the_new_and_previous_owner() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    let last = |action: Symbol, new_owner: &Address, previous: &Address| {
        let events = env.events().all();
        assert_eq!(events.len(), 1);
        let ev = events.last().unwrap();
        assert_eq!(ev.1.len(), 2);
        assert_eq!(Symbol::try_from_val(&env, &ev.1.get(0).unwrap()).unwrap(), symbol_short!("doqtri_ws"));
        assert_eq!(Symbol::try_from_val(&env, &ev.1.get(1).unwrap()).unwrap(), action);
        let value = <(String, Address, Address)>::try_from_val(&env, &ev.2).unwrap();
        assert_eq!(value, (ws.clone(), new_owner.clone(), previous.clone()));
    };

    t.client.transfer_workspace(&ws, &t.owner, &t.heir);
    last(symbol_short!("ws_xfer"), &t.heir, &t.owner);
    t.client.admin_reassign_owner(&ws, &t.admin);
    last(symbol_short!("ws_recov"), &t.admin, &t.heir);
    // Reassigning to the current owner changes nothing and says nothing.
    t.client.admin_reassign_owner(&ws, &t.admin);
    assert_eq!(env.events().all().len(), 0);
}
