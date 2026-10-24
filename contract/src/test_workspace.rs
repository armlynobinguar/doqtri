#![cfg(test)]
//! Tests for workspaces: roles, the member list, and the revoker.

extern crate std;

use super::*;
use soroban_sdk::testutils::storage::Instance as _;
use soroban_sdk::testutils::{Address as _, Events, MockAuth, MockAuthInvoke};
use soroban_sdk::{map, symbol_short, vec, Address, BytesN, Env, IntoVal, String, Symbol, TryFromVal, Val, Vec};

struct Setup<'a> {
    env: &'a Env,
    client: DoqtriRegistryClient<'a>,
    /// May upgrade the contract and set the revoker.
    contract_admin: Address,
    /// Owns the workspace and the document `plan`.
    owner: Address,
    admin: Address,
    editor: Address,
    revoker: Address,
    stranger: Address,
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

/// A workspace `ws` with one admin and one editor, the contract-wide
/// revoker, and a document `plan` its owner anchored and assigned to it.
/// Every auth is mocked.
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
        revoker: Address::generate(env),
        stranger: Address::generate(env),
    };
    let ws = t.ws();
    t.client.create_workspace(&ws, &t.owner);
    t.client.add_admin(&ws, &t.owner, &t.admin);
    t.client.add_editor(&ws, &t.admin, &t.editor);
    t.client.set_revoker(&t.revoker);
    t.client.anchor(&t.owner, &t.plan(), &hash(env, 1), &Vec::new(env));
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

    /// Allows only `who` to sign the next call, to `fn_name` with `args`.
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

    /// The address whose signature the last call asked for.
    fn signer_of_last_call(&self) -> Address {
        let auths = self.env.auths();
        assert_eq!(auths.len(), 1);
        auths[0].0.clone()
    }
}

// ---- Workspace management --------------------------------------------------

#[test]
fn create_workspace_records_the_owner() {
    let env = Env::default();
    let t = setup(&env);

    let other = s(&env, "ws-2");
    t.client.create_workspace(&other, &t.stranger);
    assert_eq!(t.signer_of_last_call(), t.stranger);

    let ws = t.client.get_workspace(&other);
    assert_eq!(ws.owner, t.stranger);
    assert!(ws.members.is_empty());
    assert!(t.client.is_editor(&other, &t.stranger));
    // The owner holds no member role; its rights come from the workspace.
    assert_eq!(t.client.get_role(&other, &t.stranger), None);
}

#[test]
fn create_workspace_refuses_a_taken_id() {
    let env = Env::default();
    let t = setup(&env);
    let result = t.client.try_create_workspace(&t.ws(), &t.stranger);
    assert_eq!(result, Err(Ok(Error::WorkspaceAlreadyExists)));
    assert_eq!(t.client.get_workspace(&t.ws()).owner, t.owner);
}

#[test]
fn unknown_workspaces_are_reported() {
    let env = Env::default();
    let t = setup(&env);
    let ghost = s(&env, "ghost");
    assert_eq!(t.client.try_get_workspace(&ghost), Err(Ok(Error::WorkspaceNotFound)));
    assert_eq!(t.client.try_add_admin(&ghost, &t.owner, &t.admin), Err(Ok(Error::WorkspaceNotFound)));
    assert_eq!(t.client.try_remove_admin(&ghost, &t.owner, &t.admin), Err(Ok(Error::WorkspaceNotFound)));
    assert_eq!(t.client.try_add_editor(&ghost, &t.owner, &t.editor), Err(Ok(Error::WorkspaceNotFound)));
    assert_eq!(t.client.try_remove_editor(&ghost, &t.owner, &t.editor), Err(Ok(Error::WorkspaceNotFound)));
    assert_eq!(t.client.try_assign_document(&t.plan(), &ghost), Err(Ok(Error::WorkspaceNotFound)));
    assert_eq!(t.client.try_get_members(&ghost), Err(Ok(Error::WorkspaceNotFound)));
    assert!(!t.client.is_editor(&ghost, &t.owner));
    assert_eq!(t.client.get_role(&ghost, &t.admin), None);
}

#[test]
fn roles_are_readable() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    assert_eq!(t.client.get_role(&ws, &t.admin), Some(Role::Admin));
    assert_eq!(t.client.get_role(&ws, &t.editor), Some(Role::Editor));
    assert_eq!(t.client.get_role(&ws, &t.stranger), None);
    assert_eq!(t.client.get_revoker(), Some(t.revoker.clone()));
    for who in [&t.owner, &t.admin, &t.editor] {
        assert!(t.client.is_editor(&ws, who));
    }
    // The revoker can remove editors but is not one.
    assert!(!t.client.is_editor(&ws, &t.revoker));
    assert!(!t.client.is_editor(&ws, &t.stranger));
}

#[test]
fn the_owner_adds_and_removes_admins() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();

    // Promoting an editor.
    t.client.add_admin(&ws, &t.owner, &t.editor);
    assert_eq!(t.signer_of_last_call(), t.owner);
    assert_eq!(t.client.get_role(&ws, &t.editor), Some(Role::Admin));

    assert!(t.client.remove_admin(&ws, &t.owner, &t.editor));
    assert_eq!(t.signer_of_last_call(), t.owner);
    // remove_admin takes the member out altogether.
    assert_eq!(t.client.get_role(&ws, &t.editor), None);
    assert!(!t.client.is_editor(&ws, &t.editor));
    // Again: nothing to remove, and it still succeeds.
    assert!(!t.client.remove_admin(&ws, &t.owner, &t.editor));
}

#[test]
fn remove_admin_leaves_editors_alone() {
    let env = Env::default();
    let t = setup(&env);
    assert!(!t.client.remove_admin(&t.ws(), &t.owner, &t.editor));
    assert_eq!(t.client.get_role(&t.ws(), &t.editor), Some(Role::Editor));
}

#[test]
fn only_the_owner_changes_admins() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    for caller in [&t.admin, &t.editor, &t.revoker, &t.stranger] {
        assert_eq!(t.client.try_add_admin(&ws, caller, &t.stranger), Err(Ok(Error::NotWorkspaceOwner)));
    }
    // The revoker may remove admins (see the_revoker_removes_admins); no one
    // else but the owner may.
    for caller in [&t.admin, &t.editor, &t.stranger] {
        assert_eq!(t.client.try_remove_admin(&ws, caller, &t.admin), Err(Ok(Error::NotWorkspaceOwner)));
    }
    assert_eq!(t.client.get_role(&ws, &t.admin), Some(Role::Admin));
    assert_eq!(t.client.get_role(&ws, &t.stranger), None);
}

#[test]
fn the_owner_is_never_a_member_role() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    assert_eq!(t.client.try_add_admin(&ws, &t.owner, &t.owner), Err(Ok(Error::TargetIsOwner)));
    assert_eq!(t.client.try_remove_admin(&ws, &t.owner, &t.owner), Err(Ok(Error::TargetIsOwner)));
    assert_eq!(t.client.try_add_editor(&ws, &t.admin, &t.owner), Err(Ok(Error::TargetIsOwner)));
    assert_eq!(t.client.try_remove_editor(&ws, &t.admin, &t.owner), Err(Ok(Error::TargetIsOwner)));
    assert_eq!(t.client.try_remove_editor(&ws, &t.revoker, &t.owner), Err(Ok(Error::TargetIsOwner)));
    assert!(t.client.is_editor(&ws, &t.owner));
}

#[test]
fn admins_and_the_owner_add_editors() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    let second = Address::generate(&env);

    t.client.add_editor(&ws, &t.admin, &t.stranger);
    assert_eq!(t.signer_of_last_call(), t.admin);
    t.client.add_editor(&ws, &t.owner, &second);
    assert_eq!(t.signer_of_last_call(), t.owner);
    assert_eq!(t.client.get_role(&ws, &t.stranger), Some(Role::Editor));
    assert_eq!(t.client.get_role(&ws, &second), Some(Role::Editor));

    // Adding an existing member changes nothing: an admin stays an admin.
    t.client.add_editor(&ws, &t.owner, &t.admin);
    assert_eq!(t.client.get_role(&ws, &t.admin), Some(Role::Admin));
    assert!(t.env.events().all().is_empty());
}

#[test]
fn editors_strangers_and_the_revoker_cannot_add_editors() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    let newcomer = Address::generate(&env);
    for caller in [&t.editor, &t.revoker, &t.stranger] {
        assert_eq!(t.client.try_add_editor(&ws, caller, &newcomer), Err(Ok(Error::NotWorkspaceAdmin)));
    }
    assert_eq!(t.client.get_role(&ws, &newcomer), None);
}

#[test]
fn admins_the_owner_and_the_revoker_remove_editors() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    for caller in [&t.admin, &t.owner, &t.revoker] {
        let editor = Address::generate(&env);
        t.client.add_editor(&ws, &t.admin, &editor);
        assert!(t.client.remove_editor(&ws, caller, &editor));
        assert_eq!(t.signer_of_last_call(), *caller);
        assert_eq!(t.client.get_role(&ws, &editor), None);
        assert!(!t.client.is_editor(&ws, &editor));
        // A retried removal still succeeds, and reports there was nothing left.
        assert!(!t.client.remove_editor(&ws, caller, &editor));
    }
}

#[test]
fn editors_and_strangers_cannot_remove_editors() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    let other = Address::generate(&env);
    t.client.add_editor(&ws, &t.admin, &other);
    for caller in [&t.editor, &t.stranger] {
        assert_eq!(t.client.try_remove_editor(&ws, caller, &other), Err(Ok(Error::NotWorkspaceAdmin)));
    }
    assert_eq!(t.client.get_role(&ws, &other), Some(Role::Editor));
}

#[test]
fn remove_editor_never_removes_an_admin() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    for caller in [&t.revoker, &t.admin, &t.owner] {
        assert_eq!(t.client.try_remove_editor(&ws, caller, &t.admin), Err(Ok(Error::TargetIsAdmin)));
    }
    assert_eq!(t.client.get_role(&ws, &t.admin), Some(Role::Admin));
}

/// D-16's revoker is one server key for the whole contract, set by the
/// contract admin. No workspace's owner or admin can replace it, so a
/// removed admin can't swap in their own key and add editors it can't
/// remove.
#[test]
fn only_the_contract_admin_sets_the_revoker() {
    let env = Env::default();
    let t = setup(&env);
    let next = Address::generate(&env);

    for who in [&t.owner, &t.admin, &t.editor, &t.revoker, &t.stranger] {
        t.only(who, "set_revoker", (who.clone(),));
        assert!(t.client.try_set_revoker(who).is_err());
    }
    assert_eq!(t.client.get_revoker(), Some(t.revoker.clone()));

    t.only(&t.contract_admin, "set_revoker", (next.clone(),));
    t.client.set_revoker(&next);
    assert_eq!(t.signer_of_last_call(), t.contract_admin);
    assert_eq!(t.client.get_revoker(), Some(next.clone()));

    // The replaced revoker loses its power at once.
    env.mock_all_auths();
    let ws = t.ws();
    assert_eq!(t.client.try_remove_editor(&ws, &t.revoker, &t.editor), Err(Ok(Error::NotWorkspaceAdmin)));
    assert_eq!(t.client.try_remove_admin(&ws, &t.revoker, &t.admin), Err(Ok(Error::NotWorkspaceOwner)));
    assert!(t.client.remove_editor(&ws, &next, &t.editor));
}

#[test]
fn the_revoker_works_in_every_workspace() {
    let env = Env::default();
    let t = setup(&env);
    let other = s(&env, "ws-2");
    t.client.create_workspace(&other, &t.stranger);
    t.client.add_editor(&other, &t.stranger, &t.editor);
    t.client.add_admin(&other, &t.stranger, &t.admin);
    assert!(t.client.remove_editor(&other, &t.revoker, &t.editor));
    assert!(t.client.remove_admin(&other, &t.revoker, &t.admin));
    assert!(t.client.get_members(&other).is_empty());
}

#[test]
fn with_no_revoker_set_only_admins_and_the_owner_remove() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(DoqtriRegistry, (Address::generate(&env),));
    let client = DoqtriRegistryClient::new(&env, &contract_id);
    let (owner, admin, editor, someone) =
        (Address::generate(&env), Address::generate(&env), Address::generate(&env), Address::generate(&env));
    let ws = s(&env, "ws-1");
    client.create_workspace(&ws, &owner);
    client.add_admin(&ws, &owner, &admin);
    client.add_editor(&ws, &owner, &editor);

    assert_eq!(client.get_revoker(), None);
    assert_eq!(client.try_remove_editor(&ws, &someone, &editor), Err(Ok(Error::NotWorkspaceAdmin)));
    assert_eq!(client.try_remove_admin(&ws, &someone, &admin), Err(Ok(Error::NotWorkspaceOwner)));
    assert!(client.remove_editor(&ws, &admin, &editor));
    assert!(client.remove_admin(&ws, &owner, &admin));
}

/// The revoker closes the gap where only the owner could remove an admin:
/// an admin removed in the app loses chain access with one server call.
#[test]
fn the_revoker_removes_admins() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    assert!(t.client.remove_admin(&ws, &t.revoker, &t.admin));
    assert_eq!(t.signer_of_last_call(), t.revoker);
    assert_eq!(t.client.get_role(&ws, &t.admin), None);
    assert!(!t.client.is_editor(&ws, &t.admin));
    // Retried: nothing left, still succeeds.
    assert!(!t.client.remove_admin(&ws, &t.revoker, &t.admin));
    // It is not remove_editor's job, and the revoker can't remove the owner.
    assert!(!t.client.remove_admin(&ws, &t.revoker, &t.editor));
    assert_eq!(t.client.get_role(&ws, &t.editor), Some(Role::Editor));
    assert_eq!(t.client.try_remove_admin(&ws, &t.revoker, &t.owner), Err(Ok(Error::TargetIsOwner)));
}

/// The revoker is a server key: it may remove members and do nothing else.
#[test]
fn the_revoker_can_only_remove_members() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    let r = &t.revoker;
    let newcomer = Address::generate(&env);

    assert_eq!(t.client.try_add_editor(&ws, r, &newcomer), Err(Ok(Error::NotWorkspaceAdmin)));
    assert_eq!(t.client.try_add_admin(&ws, r, &newcomer), Err(Ok(Error::NotWorkspaceOwner)));
    assert_eq!(t.client.try_add_admin(&ws, r, r), Err(Ok(Error::NotWorkspaceOwner)));
    assert_eq!(t.client.try_remove_editor(&ws, r, &t.admin), Err(Ok(Error::TargetIsAdmin)));
    // set_revoker asks the contract admin, not the revoker.
    t.only(r, "set_revoker", (newcomer.clone(),));
    assert!(t.client.try_set_revoker(&newcomer).is_err());
    env.mock_all_auths();

    let plan = t.plan();
    assert_eq!(t.client.try_update_document_as(r, &plan, &hash(&env, 9)), Err(Ok(Error::NotEditor)));
    assert_eq!(
        t.client.try_set_node_status_as(r, &plan, &s(&env, "root"), &NodeStatus::Verified, &s(&env, "x"), &s(&env, "y")),
        Err(Ok(Error::NotEditor))
    );
    assert_eq!(
        t.client.try_anchor_as(r, &plan, &hash(&env, 9), &vec![&env, update(&env, "root", NodeStatus::Built)]),
        Err(Ok(Error::NotEditor))
    );
    assert_eq!(t.client.try_anchor(r, &plan, &hash(&env, 9), &Vec::new(&env)), Err(Ok(Error::NotOwner)));
    // Moving or unassigning the document asks its owner, not the revoker.
    let other = s(&env, "ws-2");
    t.client.create_workspace(&other, r);
    t.only(r, "assign_document", (plan.clone(), other.clone()));
    assert!(t.client.try_assign_document(&plan, &other).is_err());
    t.only(r, "unassign_document", (plan.clone(),));
    assert!(t.client.try_unassign_document(&plan).is_err());
    env.mock_all_auths();

    // Nothing moved.
    assert_eq!(t.client.get_role(&ws, &newcomer), None);
    assert_eq!(t.client.get_role(&ws, r), None);
    assert_eq!(t.client.get_role(&ws, &t.admin), Some(Role::Admin));
    assert_eq!(t.client.get_revoker(), Some(r.clone()));
    assert_eq!(t.client.get_doc_workspace(&plan), Some(ws.clone()));
    let doc = t.client.get_document(&plan);
    assert_eq!((doc.version, doc.content_hash, doc.node_count), (1, hash(&env, 1), 0));

    // What it may do, it can.
    assert!(t.client.remove_editor(&ws, r, &t.editor));
    assert!(t.client.remove_admin(&ws, r, &t.admin));
}

// ---- The member list -------------------------------------------------------

/// D-15: the member list is on-chain and readable whole, so the app can
/// reconcile it against its own, including members an admin added
/// directly on-chain.
#[test]
fn get_members_lists_every_member_and_role() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    assert_eq!(
        t.client.get_members(&ws),
        map![&env, (t.admin.clone(), Role::Admin), (t.editor.clone(), Role::Editor)]
    );
    assert_eq!(t.client.get_workspace(&ws).members, t.client.get_members(&ws));

    t.client.add_editor(&ws, &t.admin, &t.stranger);
    t.client.add_admin(&ws, &t.owner, &t.editor);
    assert!(t.client.remove_admin(&ws, &t.revoker, &t.admin));
    assert_eq!(
        t.client.get_members(&ws),
        map![&env, (t.editor.clone(), Role::Admin), (t.stranger.clone(), Role::Editor)]
    );
    assert!(t.client.remove_editor(&ws, &t.revoker, &t.stranger));
    assert_eq!(t.client.get_members(&ws), map![&env, (t.editor.clone(), Role::Admin)]);
}

#[test]
fn a_workspace_holds_at_most_max_members() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    // setup added two.
    for _ in 2..MAX_MEMBERS {
        t.client.add_editor(&ws, &t.admin, &Address::generate(&env));
    }
    assert_eq!(t.client.get_members(&ws).len(), MAX_MEMBERS);

    let one_more = Address::generate(&env);
    assert_eq!(t.client.try_add_editor(&ws, &t.admin, &one_more), Err(Ok(Error::TooManyMembers)));
    assert_eq!(t.client.try_add_admin(&ws, &t.owner, &one_more), Err(Ok(Error::TooManyMembers)));
    // Changing an existing member's role, or re-adding one, is still fine.
    t.client.add_admin(&ws, &t.owner, &t.editor);
    t.client.add_editor(&ws, &t.admin, &t.editor);
    assert_eq!(t.client.get_members(&ws).len(), MAX_MEMBERS);

    // A removal frees a place.
    assert!(t.client.remove_admin(&ws, &t.revoker, &t.editor));
    t.client.add_editor(&ws, &t.admin, &one_more);
    assert_eq!(t.client.get_role(&ws, &one_more), Some(Role::Editor));
}

/// A removal by the revoker keeps the contract instance, where the revoker
/// lives, from expiring, so the server's next removal needs no restore.
#[test]
fn a_revoker_removal_extends_the_instance() {
    let env = Env::default();
    let t = setup(&env);
    let ttl = || env.as_contract(&t.client.address, || env.storage().instance().get_ttl());
    assert!(ttl() < 30 * 17280);
    t.client.remove_editor(&t.ws(), &t.revoker, &t.editor);
    assert_eq!(ttl(), 90 * 17280);
}

/// With no mocked signatures, every role change is refused by the host.
#[test]
fn workspace_calls_need_a_signature() {
    let env = Env::default();
    let t = setup(&env);
    env.set_auths(&[]);
    let ws = t.ws();
    let newcomer = Address::generate(&env);

    assert!(t.client.try_create_workspace(&s(&env, "ws-2"), &t.owner).is_err());
    assert!(t.client.try_add_admin(&ws, &t.owner, &newcomer).is_err());
    assert!(t.client.try_remove_admin(&ws, &t.owner, &t.admin).is_err());
    assert!(t.client.try_add_editor(&ws, &t.admin, &newcomer).is_err());
    assert!(t.client.try_remove_editor(&ws, &t.revoker, &t.editor).is_err());
    assert!(t.client.try_remove_admin(&ws, &t.revoker, &t.admin).is_err());
    assert!(t.client.try_set_revoker(&newcomer).is_err());
    assert!(t.client.try_assign_document(&t.plan(), &ws).is_err());
    assert!(t.client.try_unassign_document(&t.plan()).is_err());

    assert!(t.client.try_get_workspace(&s(&env, "ws-2")).is_err());
    assert_eq!(t.client.get_role(&ws, &newcomer), None);
    assert_eq!(t.client.get_role(&ws, &t.admin), Some(Role::Admin));
    assert_eq!(t.client.get_role(&ws, &t.editor), Some(Role::Editor));
    assert_eq!(t.client.get_revoker(), Some(t.revoker.clone()));
    assert_eq!(t.client.get_doc_workspace(&t.plan()), Some(ws));
}

/// Naming someone else as the caller doesn't help: the host asks that
/// address, not whoever signed.
#[test]
fn a_signature_from_another_address_does_not_count() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    let newcomer = Address::generate(&env);

    // The stranger signs a call that names the admin as the caller.
    t.only(&t.stranger, "add_editor", (ws.clone(), t.admin.clone(), newcomer.clone()));
    assert!(t.client.try_add_editor(&ws, &t.admin, &newcomer).is_err());
    // The editor signs a removal that names the revoker.
    t.only(&t.editor, "remove_editor", (ws.clone(), t.revoker.clone(), t.admin.clone()));
    assert!(t.client.try_remove_editor(&ws, &t.revoker, &t.admin).is_err());
    // The admin signs the owner's admin change.
    t.only(&t.admin, "add_admin", (ws.clone(), t.owner.clone(), newcomer.clone()));
    assert!(t.client.try_add_admin(&ws, &t.owner, &newcomer).is_err());

    assert_eq!(t.client.get_role(&ws, &newcomer), None);
}

/// Workspace events have their own first topic, `doqtri_ws`, so the
/// `doqtri` events keep a doc_id as their value.
#[test]
fn workspace_events_carry_the_workspace_subject_and_caller() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    let newcomer = Address::generate(&env);

    let topics = |ev: &(Address, Vec<Val>, Val)| -> (Symbol, Symbol) {
        assert_eq!(ev.1.len(), 2);
        (
            Symbol::try_from_val(&env, &ev.1.get(0).unwrap()).unwrap(),
            Symbol::try_from_val(&env, &ev.1.get(1).unwrap()).unwrap(),
        )
    };
    let last = |action: Symbol, subject: &Address, caller: &Address| {
        let events = env.events().all();
        assert_eq!(events.len(), 1);
        let ev = events.last().unwrap();
        assert_eq!(topics(&ev), (symbol_short!("doqtri_ws"), action));
        let value = <(String, Address, Address)>::try_from_val(&env, &ev.2).unwrap();
        assert_eq!(value, (ws.clone(), subject.clone(), caller.clone()));
    };

    t.client.add_editor(&ws, &t.admin, &newcomer);
    last(symbol_short!("edit_add"), &newcomer, &t.admin);
    t.client.remove_editor(&ws, &t.revoker, &newcomer);
    last(symbol_short!("edit_rm"), &newcomer, &t.revoker);
    t.client.add_admin(&ws, &t.owner, &newcomer);
    last(symbol_short!("admin_add"), &newcomer, &t.owner);
    t.client.remove_admin(&ws, &t.owner, &newcomer);
    last(symbol_short!("admin_rm"), &newcomer, &t.owner);
    t.client.add_admin(&ws, &t.owner, &newcomer);
    t.client.remove_admin(&ws, &t.revoker, &newcomer);
    last(symbol_short!("admin_rm"), &newcomer, &t.revoker);

    let other = s(&env, "ws-2");
    t.client.create_workspace(&other, &newcomer);
    let ev = env.events().all().last().unwrap();
    assert_eq!(topics(&ev), (symbol_short!("doqtri_ws"), symbol_short!("ws_create")));
    assert_eq!(
        <(String, Address, Address)>::try_from_val(&env, &ev.2).unwrap(),
        (other, newcomer.clone(), newcomer.clone())
    );

    t.client.set_revoker(&newcomer);
    let ev = env.events().all().last().unwrap();
    assert_eq!(topics(&ev), (symbol_short!("doqtri_ws"), symbol_short!("revoker")));
    assert_eq!(Address::try_from_val(&env, &ev.2).unwrap(), newcomer);
}
