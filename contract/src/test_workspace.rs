#![cfg(test)]
//! Tests for workspaces: roles, the revoker, document assignment, and the
//! `*_as` write calls that let workspace members sign their own writes.

extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Events, MockAuth, MockAuthInvoke};
use soroban_sdk::{symbol_short, vec, Address, BytesN, Env, IntoVal, String, Symbol, TryFromVal, Val, Vec};

struct Setup<'a> {
    env: &'a Env,
    client: DoqtriRegistryClient<'a>,
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

/// A workspace `ws` with one admin, one editor and a revoker, and a document
/// `plan` its owner anchored and assigned to it. Every auth is mocked.
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
    };
    let ws = t.ws();
    t.client.create_workspace(&ws, &t.owner);
    t.client.add_admin(&ws, &t.owner, &t.admin);
    t.client.add_editor(&ws, &t.admin, &t.editor);
    t.client.set_revoker(&ws, &t.owner, &t.revoker);
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
    assert_eq!(t.client.try_set_revoker(&ghost, &t.owner, &t.revoker), Err(Ok(Error::WorkspaceNotFound)));
    assert_eq!(t.client.try_assign_document(&t.plan(), &ghost), Err(Ok(Error::WorkspaceNotFound)));
    assert!(!t.client.is_editor(&ghost, &t.owner));
    assert_eq!(t.client.get_revoker(&ghost), None);
}

#[test]
fn roles_are_readable() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    assert_eq!(t.client.get_role(&ws, &t.admin), Some(Role::Admin));
    assert_eq!(t.client.get_role(&ws, &t.editor), Some(Role::Editor));
    assert_eq!(t.client.get_role(&ws, &t.stranger), None);
    assert_eq!(t.client.get_revoker(&ws), Some(t.revoker.clone()));
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

#[test]
fn admins_and_the_owner_set_the_revoker() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    let next = Address::generate(&env);

    t.client.set_revoker(&ws, &t.admin, &next);
    assert_eq!(t.signer_of_last_call(), t.admin);
    assert_eq!(t.client.get_revoker(&ws), Some(next.clone()));

    // The replaced revoker loses its power at once.
    assert_eq!(t.client.try_remove_editor(&ws, &t.revoker, &t.editor), Err(Ok(Error::NotWorkspaceAdmin)));
    assert!(t.client.remove_editor(&ws, &next, &t.editor));

    for caller in [&t.editor, &t.stranger] {
        assert_eq!(t.client.try_set_revoker(&ws, caller, caller), Err(Ok(Error::NotWorkspaceAdmin)));
    }
    assert_eq!(t.client.get_revoker(&ws), Some(next));
}

#[test]
fn a_workspace_without_a_revoker_only_lets_admins_remove() {
    let env = Env::default();
    let t = setup(&env);
    let other = s(&env, "ws-2");
    t.client.create_workspace(&other, &t.owner);
    t.client.add_editor(&other, &t.owner, &t.editor);
    assert_eq!(t.client.get_revoker(&other), None);
    // The revoker of ws-1 has no say in ws-2.
    assert_eq!(t.client.try_remove_editor(&other, &t.revoker, &t.editor), Err(Ok(Error::NotWorkspaceAdmin)));
    assert!(t.client.is_editor(&other, &t.editor));
}

/// The revoker is a server key: it may remove editors and do nothing else.
#[test]
fn the_revoker_can_only_remove_editors() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    let r = &t.revoker;
    let newcomer = Address::generate(&env);

    assert_eq!(t.client.try_add_editor(&ws, r, &newcomer), Err(Ok(Error::NotWorkspaceAdmin)));
    assert_eq!(t.client.try_add_admin(&ws, r, &newcomer), Err(Ok(Error::NotWorkspaceOwner)));
    assert_eq!(t.client.try_add_admin(&ws, r, r), Err(Ok(Error::NotWorkspaceOwner)));
    assert_eq!(t.client.try_remove_admin(&ws, r, &t.admin), Err(Ok(Error::NotWorkspaceOwner)));
    assert_eq!(t.client.try_set_revoker(&ws, r, &newcomer), Err(Ok(Error::NotWorkspaceAdmin)));
    assert_eq!(t.client.try_remove_editor(&ws, r, &t.admin), Err(Ok(Error::TargetIsAdmin)));

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

    // Nothing moved.
    assert_eq!(t.client.get_role(&ws, &newcomer), None);
    assert_eq!(t.client.get_role(&ws, r), None);
    assert_eq!(t.client.get_role(&ws, &t.admin), Some(Role::Admin));
    assert_eq!(t.client.get_revoker(&ws), Some(r.clone()));
    let doc = t.client.get_document(&plan);
    assert_eq!((doc.version, doc.content_hash, doc.node_count), (1, hash(&env, 1), 0));

    // What it may do, it can.
    assert!(t.client.remove_editor(&ws, r, &t.editor));
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
    assert!(t.client.try_set_revoker(&ws, &t.admin, &newcomer).is_err());
    assert!(t.client.try_assign_document(&t.plan(), &ws).is_err());

    assert!(t.client.try_get_workspace(&s(&env, "ws-2")).is_err());
    assert_eq!(t.client.get_role(&ws, &newcomer), None);
    assert_eq!(t.client.get_role(&ws, &t.admin), Some(Role::Admin));
    assert_eq!(t.client.get_role(&ws, &t.editor), Some(Role::Editor));
    assert_eq!(t.client.get_revoker(&ws), Some(t.revoker.clone()));
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

#[test]
fn workspace_events_carry_the_workspace_subject_and_caller() {
    let env = Env::default();
    let t = setup(&env);
    let ws = t.ws();
    let newcomer = Address::generate(&env);

    let last = |action: Symbol, subject: &Address, caller: &Address| {
        let events = env.events().all();
        assert_eq!(events.len(), 1);
        let ev = events.last().unwrap();
        assert_eq!(ev.1.len(), 2);
        assert_eq!(Symbol::try_from_val(&env, &ev.1.get(0).unwrap()).unwrap(), symbol_short!("doqtri"));
        assert_eq!(Symbol::try_from_val(&env, &ev.1.get(1).unwrap()).unwrap(), action);
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
    t.client.set_revoker(&ws, &t.admin, &newcomer);
    last(symbol_short!("revoker"), &newcomer, &t.admin);

    let other = s(&env, "ws-2");
    t.client.create_workspace(&other, &newcomer);
    let ev = env.events().all().last().unwrap();
    assert_eq!(Symbol::try_from_val(&env, &ev.1.get(1).unwrap()).unwrap(), symbol_short!("ws_create"));
    assert_eq!(
        <(String, Address, Address)>::try_from_val(&env, &ev.2).unwrap(),
        (other, newcomer.clone(), newcomer)
    );
}
