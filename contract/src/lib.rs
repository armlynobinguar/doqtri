#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env,
    Map, String, Symbol, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    DocumentAlreadyExists = 1,
    DocumentNotFound = 2,
    NodeNotFound = 3,
    /// `anchor` was given more than `MAX_NODES_PER_CALL` node updates.
    TooManyNodes = 4,
    /// `anchor` named an owner other than the document's owner.
    NotOwner = 5,
    /// `create_workspace` was given an id that is already taken.
    WorkspaceAlreadyExists = 6,
    WorkspaceNotFound = 7,
    /// The call needs the workspace's owner (`add_admin`), or for
    /// `remove_admin` the owner or the revoker.
    NotWorkspaceOwner = 8,
    /// The call needs a workspace admin or its owner (`add_editor`), or for
    /// `remove_editor` also the revoker.
    NotWorkspaceAdmin = 9,
    /// An `*_as` signer is neither the document's owner nor a member of the
    /// workspace the document is assigned to; `assign_document` was asked to
    /// put a document in a workspace its owner is not a member of.
    NotEditor = 10,
    /// The workspace owner's rights come from the workspace itself and can't
    /// be added or removed as a member role.
    TargetIsOwner = 11,
    /// `remove_editor` never removes an admin; the owner or the revoker
    /// does that with `remove_admin`.
    TargetIsAdmin = 12,
    /// The workspace already has `MAX_MEMBERS` members.
    TooManyMembers = 13,
}

/// Lifecycle of a mindmap node, from plan to verified deployment.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NodeStatus {
    Planned,
    Building,
    Built,
    Verified,
}

/// An anchored document: who owns it, its latest content hash, and version.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Document {
    pub owner: Address,
    pub content_hash: BytesN<32>,
    pub version: u32,
    pub node_count: u32,
    pub updated_at: u64,
}

/// Build-status record for a single mindmap node.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeRecord {
    pub status: NodeStatus,
    pub tool: String,
    pub artifact_ref: String,
    pub updated_at: u64,
}

/// One node's new status, for `anchor`'s batch of node updates.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeUpdate {
    pub node_id: String,
    pub status: NodeStatus,
    pub tool: String,
    pub artifact_ref: String,
}

/// A shared space whose members may write its documents. Its owner holds
/// every right in it and owns every document in it (D-28); ownership moves
/// only by `transfer_workspace` or the contract admin's
/// `admin_reassign_owner`.
/// `members` is the on-chain member list (D-15): every address with a role,
/// the owner aside, at most `MAX_MEMBERS` of them, so it can be read whole
/// to audit who holds write access.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Workspace {
    pub owner: Address,
    pub created_at: u64,
    pub members: Map<Address, Role>,
}

/// A workspace member's role. Both may write the workspace's documents;
/// an admin may also add and remove editors.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Role {
    Editor,
    Admin,
}

// New variants go at the end: a key's encoding is its variant name plus
// fields, so existing `Doc`/`Node`/`Admin` entries keep loading after an upgrade.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Doc(String),
    Node(String, String),
    /// Who may `upgrade` the contract and `import_*` documents (instance storage).
    Admin,
    /// workspace_id -> `Workspace`, members included.
    Workspace(String),
    /// The app's revoke-only server key (instance storage, contract-wide):
    /// it may only remove members, in any workspace. Set by the contract admin.
    Revoker,
    /// doc_id -> workspace_id whose members may write the document.
    DocWorkspace(String),
}

/// Most node updates one `anchor` call takes, so a single transaction stays
/// well inside Soroban's resource limits.
pub const MAX_NODES_PER_CALL: u32 = 32;

/// Most members (admins and editors; the owner aside) one workspace holds,
/// so its entry, read by every member write, stays a few kilobytes.
pub const MAX_MEMBERS: u32 = 100;

const DAY_IN_LEDGERS: u32 = 17280;
const TTL_THRESHOLD: u32 = DAY_IN_LEDGERS * 30;
const TTL_EXTEND: u32 = DAY_IN_LEDGERS * 90;

#[contract]
pub struct DoqtriRegistry;

fn load_doc(env: &Env, doc_id: &String) -> Result<Document, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Doc(doc_id.clone()))
        .ok_or(Error::DocumentNotFound)
}

fn store_doc(env: &Env, doc_id: &String, doc: &Document) {
    let key = DataKey::Doc(doc_id.clone());
    env.storage().persistent().set(&key, doc);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
    touch_doc_workspace(env, doc_id);
}

/// Keeps a document's workspace entries alive as long as the document is
/// written, even when only its owner writes it (whose writes never read
/// them), so a member's write or the revoker's removal never finds them
/// archived.
fn touch_doc_workspace(env: &Env, doc_id: &String) {
    let ws_key = DataKey::DocWorkspace(doc_id.clone());
    let workspace_id: Option<String> = env.storage().persistent().get(&ws_key);
    if let Some(workspace_id) = workspace_id {
        touch(env, &ws_key);
        let key = DataKey::Workspace(workspace_id);
        if env.storage().persistent().has(&key) {
            touch(env, &key);
        }
    }
}

/// Writes one node record; returns true when the node is new to the document.
fn store_node(env: &Env, doc_id: &String, node_id: String, record: &NodeRecord) -> bool {
    let key = DataKey::Node(doc_id.clone(), node_id);
    let is_new = !env.storage().persistent().has(&key);
    env.storage().persistent().set(&key, record);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
    is_new
}

fn require_admin(env: &Env) {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("admin is set by the constructor");
    admin.require_auth();
}

fn persist<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey, value: &V) {
    env.storage().persistent().set(key, value);
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND);
}

/// Keeps an entry that an authorization check just relied on from expiring
/// while it is still in use.
fn touch(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND);
}

fn load_workspace(env: &Env, workspace_id: &String) -> Result<Workspace, Error> {
    let key = DataKey::Workspace(workspace_id.clone());
    let ws = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::WorkspaceNotFound)?;
    touch(env, &key);
    Ok(ws)
}

fn store_workspace(env: &Env, workspace_id: &String, ws: &Workspace) {
    persist(env, &DataKey::Workspace(workspace_id.clone()), ws);
}

/// True when `who` is the contract-wide revoker. A removal it authorizes
/// also keeps the contract instance, where it is stored, from expiring.
fn is_revoker(env: &Env, who: &Address) -> bool {
    let revoker: Option<Address> = env.storage().instance().get(&DataKey::Revoker);
    if revoker.as_ref() == Some(who) {
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
        true
    } else {
        false
    }
}

/// Fails unless `who` is the workspace's owner or one of its admins.
fn check_workspace_admin(ws: &Workspace, who: &Address) -> Result<(), Error> {
    if *who == ws.owner || ws.members.get(who.clone()) == Some(Role::Admin) {
        Ok(())
    } else {
        Err(Error::NotWorkspaceAdmin)
    }
}

/// True when `who` may write the workspace's documents: its owner or any member.
fn is_workspace_writer(ws: &Workspace, who: &Address) -> bool {
    *who == ws.owner || ws.members.contains_key(who.clone())
}

/// The workspace a document is assigned to, kept alive since the caller is
/// about to rely on it. None for a document in no workspace.
fn doc_workspace(env: &Env, doc_id: &String) -> Result<Option<Workspace>, Error> {
    let ws_key = DataKey::DocWorkspace(doc_id.clone());
    let workspace_id: Option<String> = env.storage().persistent().get(&ws_key);
    match workspace_id {
        None => Ok(None),
        Some(workspace_id) => {
            touch(env, &ws_key);
            Ok(Some(load_workspace(env, &workspace_id)?))
        }
    }
}

/// Loads a document with its owner resolved for an authorization check: a
/// document in a workspace is owned by the workspace's CURRENT owner (D-28),
/// whatever its stored `owner` says, so a `transfer_workspace` moves every
/// document in it without rewriting any. The returned `owner` is the one to
/// authorize against, and the one stored when the caller writes the
/// document back, so the stored copy catches up on its next write.
fn load_owned_doc(env: &Env, doc_id: &String) -> Result<(Document, Option<Workspace>), Error> {
    let mut doc = load_doc(env, doc_id)?;
    let ws = doc_workspace(env, doc_id)?;
    if let Some(ws) = &ws {
        doc.owner = ws.owner.clone();
    }
    Ok((doc, ws))
}

/// Fails unless `signer` may write the document: for one in a workspace, the
/// workspace's current owner or a member; otherwise its owner. Its stored
/// owner never counts for a workspace document, so neither a removed member
/// nor a workspace's former owner gets back in through it.
fn check_writer(doc: &Document, ws: &Option<Workspace>, signer: &Address) -> Result<(), Error> {
    let allowed = match ws {
        Some(ws) => is_workspace_writer(ws, signer),
        None => *signer == doc.owner,
    };
    if allowed {
        Ok(())
    } else {
        Err(Error::NotEditor)
    }
}

/// Publishes a document event. The owner-only calls keep their original
/// two-topic shape; the `*_as` calls add the signer as a third topic so an
/// indexer can tell who wrote, and filter by it. The value is always the
/// doc_id.
fn publish_doc_event(env: &Env, action: Symbol, signer: Option<&Address>, doc_id: &String) {
    match signer {
        None => env
            .events()
            .publish((symbol_short!("doqtri"), action), doc_id.clone()),
        Some(signer) => env.events().publish(
            (symbol_short!("doqtri"), action, signer.clone()),
            doc_id.clone(),
        ),
    }
}

/// First topic of every workspace event. Kept apart from `doqtri`, whose
/// event value is always a doc_id, so a consumer of document events never
/// meets a workspace tuple.
const WS_TOPIC: Symbol = symbol_short!("doqtri_ws");

/// Publishes a membership event: value is (workspace_id, subject, caller).
fn publish_ws_event(
    env: &Env,
    action: Symbol,
    workspace_id: &String,
    subject: &Address,
    caller: &Address,
) {
    env.events().publish(
        (WS_TOPIC, action),
        (workspace_id.clone(), subject.clone(), caller.clone()),
    );
}

/// `anchor` and `anchor_as` share this. `signer` has already authorized.
/// With `as_signer` false it is the owner-only `anchor` (NotOwner, original
/// events); with true any writer of the document may anchor it.
fn anchor_doc(
    env: &Env,
    signer: Address,
    doc_id: String,
    content_hash: BytesN<32>,
    nodes: Vec<NodeUpdate>,
    as_signer: bool,
) -> Result<u32, Error> {
    let event_signer = if as_signer { Some(&signer) } else { None };
    let now = env.ledger().timestamp();
    let mut doc = match load_owned_doc(env, &doc_id) {
        Ok((doc, ws)) => {
            if as_signer {
                check_writer(&doc, &ws, &signer)?;
            } else if doc.owner != signer {
                return Err(Error::NotOwner);
            }
            doc
        }
        Err(Error::DocumentNotFound) => {
            publish_doc_event(env, symbol_short!("register"), event_signer, &doc_id);
            Document {
                owner: signer.clone(),
                content_hash: content_hash.clone(),
                version: 1,
                node_count: 0,
                updated_at: now,
            }
        }
        Err(e) => return Err(e),
    };

    if doc.content_hash != content_hash {
        doc.content_hash = content_hash;
        doc.version += 1;
        doc.updated_at = now;
        publish_doc_event(env, symbol_short!("update"), event_signer, &doc_id);
    }

    for update in nodes.iter() {
        let record = NodeRecord {
            status: update.status,
            tool: update.tool,
            artifact_ref: update.artifact_ref,
            updated_at: now,
        };
        if store_node(env, &doc_id, update.node_id, &record) {
            doc.node_count += 1;
        }
    }
    if !nodes.is_empty() {
        publish_doc_event(env, symbol_short!("node"), event_signer, &doc_id);
    }

    store_doc(env, &doc_id, &doc);
    Ok(doc.version)
}

#[contractimpl]
impl DoqtriRegistry {
    /// Sets the admin, who alone may `upgrade` the contract and `import_*`
    /// documents from an earlier registry. Runs once, at deploy.
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Everything a finished edit needs, in one call and so one signature:
    /// registers the document if it is new, anchors `content_hash` as a new
    /// version if it changed (an unchanged hash keeps the version), then
    /// writes every node update. `owner` must be the document's owner.
    /// Returns the document's version after the call.
    pub fn anchor(
        env: Env,
        owner: Address,
        doc_id: String,
        content_hash: BytesN<32>,
        nodes: Vec<NodeUpdate>,
    ) -> Result<u32, Error> {
        if nodes.len() > MAX_NODES_PER_CALL {
            return Err(Error::TooManyNodes);
        }
        owner.require_auth();
        anchor_doc(&env, owner, doc_id, content_hash, nodes, false)
    }

    /// Replaces this contract's code with an uploaded WASM, keeping its
    /// address and every stored document. Admin only.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        require_admin(&env);
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Copies a document from an earlier registry, as it stands there, so it
    /// keeps its owner, hash, version and history. Admin only, for a one-time
    /// migration; refuses a document that already exists here.
    pub fn import_document(env: Env, doc_id: String, doc: Document) -> Result<(), Error> {
        require_admin(&env);
        if env.storage().persistent().has(&DataKey::Doc(doc_id.clone())) {
            return Err(Error::DocumentAlreadyExists);
        }
        store_doc(&env, &doc_id, &doc);
        Ok(())
    }

    /// Copies one node record of an imported document. Admin only. The
    /// document's `node_count` comes from `import_document`, so it is not
    /// changed here.
    pub fn import_node(
        env: Env,
        doc_id: String,
        node_id: String,
        record: NodeRecord,
    ) -> Result<(), Error> {
        require_admin(&env);
        load_doc(&env, &doc_id)?;
        store_node(&env, &doc_id, node_id, &record);
        Ok(())
    }

    /// The address that may upgrade the contract and import documents.
    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin is set by the constructor")
    }

    /// Anchor a new document. Fails if `doc_id` is already registered.
    /// Returns the initial version (always 1).
    pub fn register_document(
        env: Env,
        owner: Address,
        doc_id: String,
        content_hash: BytesN<32>,
    ) -> Result<u32, Error> {
        owner.require_auth();

        let key = DataKey::Doc(doc_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::DocumentAlreadyExists);
        }

        let doc = Document {
            owner,
            content_hash,
            version: 1,
            node_count: 0,
            updated_at: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&key, &doc);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);

        // Value is always `doc_id` so the Doqtri app can index from events.
        env.events()
            .publish((symbol_short!("doqtri"), symbol_short!("register")), doc_id);
        Ok(1)
    }

    /// Anchor a new content hash after a semantic change in the source doc.
    /// Only the document owner may call (for a workspace document, the
    /// workspace's current owner). Returns the new version number.
    pub fn update_document(
        env: Env,
        doc_id: String,
        new_hash: BytesN<32>,
    ) -> Result<u32, Error> {
        let key = DataKey::Doc(doc_id.clone());
        let (mut doc, _) = load_owned_doc(&env, &doc_id)?;

        doc.owner.require_auth();

        doc.content_hash = new_hash;
        doc.version += 1;
        doc.updated_at = env.ledger().timestamp();

        env.storage().persistent().set(&key, &doc);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        touch_doc_workspace(&env, &doc_id);

        // Emit doc_id (not version) — matches register/node and web chain-sync.
        env.events()
            .publish((symbol_short!("doqtri"), symbol_short!("update")), doc_id);
        Ok(doc.version)
    }

    /// Record or update the build status of a mindmap node.
    /// `tool` is the builder used (e.g. "n8n"); `artifact_ref` points to the
    /// built artifact (workflow ID, URL, or hash). Owner-only (for a
    /// workspace document, the workspace's current owner).
    pub fn set_node_status(
        env: Env,
        doc_id: String,
        node_id: String,
        status: NodeStatus,
        tool: String,
        artifact_ref: String,
    ) -> Result<(), Error> {
        let doc_key = DataKey::Doc(doc_id.clone());
        let (mut doc, _) = load_owned_doc(&env, &doc_id)?;

        doc.owner.require_auth();

        let node_key = DataKey::Node(doc_id.clone(), node_id);
        let is_new = !env.storage().persistent().has(&node_key);

        let record = NodeRecord {
            status,
            tool,
            artifact_ref,
            updated_at: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&node_key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&node_key, TTL_THRESHOLD, TTL_EXTEND);

        if is_new {
            doc.node_count += 1;
            env.storage().persistent().set(&doc_key, &doc);
            env.storage()
                .persistent()
                .extend_ttl(&doc_key, TTL_THRESHOLD, TTL_EXTEND);
        }
        touch_doc_workspace(&env, &doc_id);

        // Emit doc_id so vault sync can refresh the parent plan (node details via get_node).
        env.events()
            .publish((symbol_short!("doqtri"), symbol_short!("node")), doc_id);
        Ok(())
    }

    /// Fetch a document's anchored state. For a document in a workspace,
    /// `owner` is the workspace's current owner (D-28), even before the
    /// stored record has caught up with a transfer.
    pub fn get_document(env: Env, doc_id: String) -> Result<Document, Error> {
        let store = env.storage().persistent();
        let mut doc: Document = store
            .get(&DataKey::Doc(doc_id.clone()))
            .ok_or(Error::DocumentNotFound)?;
        let workspace_id: Option<String> = store.get(&DataKey::DocWorkspace(doc_id));
        if let Some(workspace_id) = workspace_id {
            let ws = Self::get_workspace(env, workspace_id)?;
            doc.owner = ws.owner;
        }
        Ok(doc)
    }

    /// Fetch a node's build-status record.
    pub fn get_node(env: Env, doc_id: String, node_id: String) -> Result<NodeRecord, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Node(doc_id, node_id))
            .ok_or(Error::NodeNotFound)
    }

    // ---- Workspaces ------------------------------------------------------
    //
    // A workspace lets several wallets write the same documents, each with
    // its own signature. Roles: the owner (fixed at creation) manages admins;
    // admins and the owner manage editors; every member may write the
    // documents assigned to the workspace, which the workspace's owner owns.
    // The revoker is one contract-wide server key, set by the contract
    // admin, that may only remove members (editors and admins), so a member
    // removed in the app loses chain access at once without waiting for an
    // admin or the owner to sign (D-16).
    //
    // The owner-only calls above are unchanged: workspace writes go through
    // the `*_as` calls, which name their signer.

    /// Creates a workspace owned by `owner`, with no members. Fails if the
    /// id is taken. Ids are first come, first served: the app reads
    /// `get_workspace` after creating one to check it got it.
    pub fn create_workspace(env: Env, workspace_id: String, owner: Address) -> Result<(), Error> {
        owner.require_auth();
        let key = DataKey::Workspace(workspace_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::WorkspaceAlreadyExists);
        }
        let ws = Workspace {
            owner: owner.clone(),
            created_at: env.ledger().timestamp(),
            members: Map::new(&env),
        };
        store_workspace(&env, &workspace_id, &ws);
        publish_ws_event(
            &env,
            symbol_short!("ws_create"),
            &workspace_id,
            &owner,
            &owner,
        );
        Ok(())
    }

    /// Makes `admin` a workspace admin (promoting an editor). Owner only.
    pub fn add_admin(
        env: Env,
        workspace_id: String,
        owner: Address,
        admin: Address,
    ) -> Result<(), Error> {
        owner.require_auth();
        let mut ws = load_workspace(&env, &workspace_id)?;
        if owner != ws.owner {
            return Err(Error::NotWorkspaceOwner);
        }
        if admin == ws.owner {
            return Err(Error::TargetIsOwner);
        }
        if !ws.members.contains_key(admin.clone()) && ws.members.len() >= MAX_MEMBERS {
            return Err(Error::TooManyMembers);
        }
        ws.members.set(admin.clone(), Role::Admin);
        store_workspace(&env, &workspace_id, &ws);
        publish_ws_event(
            &env,
            symbol_short!("admin_add"),
            &workspace_id,
            &admin,
            &owner,
        );
        Ok(())
    }

    /// Removes `admin` from the workspace altogether (to keep them as an
    /// editor, `add_editor` them after). `caller` must be the owner or the
    /// revoker. Returns false, changing nothing, when `admin` is not an
    /// admin, so a retried removal still succeeds.
    pub fn remove_admin(
        env: Env,
        workspace_id: String,
        caller: Address,
        admin: Address,
    ) -> Result<bool, Error> {
        caller.require_auth();
        let mut ws = load_workspace(&env, &workspace_id)?;
        if caller != ws.owner && !is_revoker(&env, &caller) {
            return Err(Error::NotWorkspaceOwner);
        }
        if admin == ws.owner {
            return Err(Error::TargetIsOwner);
        }
        if ws.members.get(admin.clone()) != Some(Role::Admin) {
            return Ok(false);
        }
        ws.members.remove(admin.clone());
        store_workspace(&env, &workspace_id, &ws);
        publish_ws_event(
            &env,
            symbol_short!("admin_rm"),
            &workspace_id,
            &admin,
            &caller,
        );
        Ok(true)
    }

    /// Makes `editor` a workspace editor. `admin` must be a workspace admin
    /// or the owner. An address that is already a member keeps its role.
    pub fn add_editor(
        env: Env,
        workspace_id: String,
        admin: Address,
        editor: Address,
    ) -> Result<(), Error> {
        admin.require_auth();
        let mut ws = load_workspace(&env, &workspace_id)?;
        check_workspace_admin(&ws, &admin)?;
        if editor == ws.owner {
            return Err(Error::TargetIsOwner);
        }
        if ws.members.contains_key(editor.clone()) {
            return Ok(());
        }
        if ws.members.len() >= MAX_MEMBERS {
            return Err(Error::TooManyMembers);
        }
        ws.members.set(editor.clone(), Role::Editor);
        store_workspace(&env, &workspace_id, &ws);
        publish_ws_event(
            &env,
            symbol_short!("edit_add"),
            &workspace_id,
            &editor,
            &admin,
        );
        Ok(())
    }

    /// Removes `editor` from the workspace. `caller` must be a workspace
    /// admin, the owner, or the revoker. Never removes an admin or the
    /// owner. Returns false, changing nothing, when `editor` is not a
    /// member, so a retried removal still succeeds.
    pub fn remove_editor(
        env: Env,
        workspace_id: String,
        caller: Address,
        editor: Address,
    ) -> Result<bool, Error> {
        caller.require_auth();
        let mut ws = load_workspace(&env, &workspace_id)?;
        if !is_revoker(&env, &caller) {
            check_workspace_admin(&ws, &caller)?;
        }
        if editor == ws.owner {
            return Err(Error::TargetIsOwner);
        }
        match ws.members.get(editor.clone()) {
            None => Ok(false),
            Some(Role::Admin) => Err(Error::TargetIsAdmin),
            Some(Role::Editor) => {
                ws.members.remove(editor.clone());
                store_workspace(&env, &workspace_id, &ws);
                publish_ws_event(
                    &env,
                    symbol_short!("edit_rm"),
                    &workspace_id,
                    &editor,
                    &caller,
                );
                Ok(true)
            }
        }
    }

    /// Sets (or replaces) the contract-wide revoker: the app's server key,
    /// which may remove editors and admins from any workspace, and nothing
    /// else. Contract admin only, so no workspace admin can swap it out.
    pub fn set_revoker(env: Env, revoker: Address) {
        require_admin(&env);
        env.storage().instance().set(&DataKey::Revoker, &revoker);
        env.events()
            .publish((WS_TOPIC, symbol_short!("revoker")), revoker);
    }

    /// Puts a document in a workspace, so the workspace's members may write
    /// it through the `*_as` calls; a document already in one moves. The
    /// document's owner signs and must be a member (or the owner) of the
    /// workspace. The workspace's owner becomes the document's owner: its
    /// author then writes it as a member, so removing them from the
    /// workspace removes their write access to it too, and it can leave the
    /// workspace only with its owner's signature. A document already in a
    /// workspace is moved by that workspace's current owner.
    pub fn assign_document(env: Env, doc_id: String, workspace_id: String) -> Result<(), Error> {
        let mut doc = load_doc(&env, &doc_id)?;
        let owner = match doc_workspace(&env, &doc_id)? {
            Some(current) => current.owner,
            None => doc.owner.clone(),
        };
        owner.require_auth();
        let ws = load_workspace(&env, &workspace_id)?;
        if !is_workspace_writer(&ws, &owner) {
            return Err(Error::NotEditor);
        }
        persist(&env, &DataKey::DocWorkspace(doc_id.clone()), &workspace_id);
        if doc.owner != ws.owner {
            doc.owner = ws.owner.clone();
            store_doc(&env, &doc_id, &doc);
        }
        env.events().publish(
            (WS_TOPIC, symbol_short!("assign")),
            (doc_id, workspace_id, ws.owner),
        );
        Ok(())
    }

    /// Takes a document out of its workspace; its members can no longer
    /// write it. It stays with the workspace's current owner, who signs, and
    /// is stored with them as its owner, since with no workspace left to
    /// resolve from the stored owner is the owner again. Returns false,
    /// changing nothing, when it is in no workspace.
    pub fn unassign_document(env: Env, doc_id: String) -> Result<bool, Error> {
        let mut doc = load_doc(&env, &doc_id)?;
        let key = DataKey::DocWorkspace(doc_id.clone());
        let workspace_id: Option<String> = env.storage().persistent().get(&key);
        let Some(workspace_id) = workspace_id else {
            doc.owner.require_auth();
            return Ok(false);
        };
        let ws = load_workspace(&env, &workspace_id)?;
        ws.owner.require_auth();
        env.storage().persistent().remove(&key);
        if doc.owner != ws.owner {
            doc.owner = ws.owner;
            store_doc(&env, &doc_id, &doc);
        }
        env.events().publish(
            (WS_TOPIC, symbol_short!("unassign")),
            (doc_id, workspace_id),
        );
        Ok(true)
    }

    /// `update_document` for any writer of the document: its owner, or the
    /// owner or a member of its workspace. `signer` must sign.
    pub fn update_document_as(
        env: Env,
        signer: Address,
        doc_id: String,
        new_hash: BytesN<32>,
    ) -> Result<u32, Error> {
        signer.require_auth();
        let (mut doc, ws) = load_owned_doc(&env, &doc_id)?;
        check_writer(&doc, &ws, &signer)?;

        doc.content_hash = new_hash;
        doc.version += 1;
        doc.updated_at = env.ledger().timestamp();
        store_doc(&env, &doc_id, &doc);

        publish_doc_event(&env, symbol_short!("update"), Some(&signer), &doc_id);
        Ok(doc.version)
    }

    /// `set_node_status` for any writer of the document. `signer` must sign.
    pub fn set_node_status_as(
        env: Env,
        signer: Address,
        doc_id: String,
        node_id: String,
        status: NodeStatus,
        tool: String,
        artifact_ref: String,
    ) -> Result<(), Error> {
        signer.require_auth();
        let (mut doc, ws) = load_owned_doc(&env, &doc_id)?;
        check_writer(&doc, &ws, &signer)?;

        let record = NodeRecord {
            status,
            tool,
            artifact_ref,
            updated_at: env.ledger().timestamp(),
        };
        if store_node(&env, &doc_id, node_id, &record) {
            doc.node_count += 1;
            store_doc(&env, &doc_id, &doc);
        }

        publish_doc_event(&env, symbol_short!("node"), Some(&signer), &doc_id);
        Ok(())
    }

    /// `anchor` for any writer of the document. A new document is registered
    /// with `signer` as its owner, as `anchor` does; `assign_document` then
    /// puts it in a workspace and hands it to the workspace's owner.
    /// `signer` must sign.
    pub fn anchor_as(
        env: Env,
        signer: Address,
        doc_id: String,
        content_hash: BytesN<32>,
        nodes: Vec<NodeUpdate>,
    ) -> Result<u32, Error> {
        if nodes.len() > MAX_NODES_PER_CALL {
            return Err(Error::TooManyNodes);
        }
        signer.require_auth();
        anchor_doc(&env, signer, doc_id, content_hash, nodes, true)
    }

    /// A workspace's owner, creation time and members.
    pub fn get_workspace(env: Env, workspace_id: String) -> Result<Workspace, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Workspace(workspace_id))
            .ok_or(Error::WorkspaceNotFound)
    }

    /// Every member of the workspace and their role, the owner aside: the
    /// list to reconcile the app's members against.
    pub fn get_members(env: Env, workspace_id: String) -> Result<Map<Address, Role>, Error> {
        Ok(Self::get_workspace(env, workspace_id)?.members)
    }

    /// `who`'s member role in the workspace; none for the owner, for
    /// non-members and for an unknown workspace.
    pub fn get_role(env: Env, workspace_id: String, who: Address) -> Option<Role> {
        Self::get_workspace(env, workspace_id)
            .ok()
            .and_then(|ws| ws.members.get(who))
    }

    /// The contract-wide revoker, if one is set.
    pub fn get_revoker(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Revoker)
    }

    /// The workspace a document is assigned to, if any.
    pub fn get_doc_workspace(env: Env, doc_id: String) -> Option<String> {
        env.storage()
            .persistent()
            .get(&DataKey::DocWorkspace(doc_id))
    }

    /// True when `who` may write the workspace's documents: its owner, an
    /// admin or an editor. False for an unknown workspace.
    pub fn is_editor(env: Env, workspace_id: String, who: Address) -> bool {
        Self::get_workspace(env, workspace_id)
            .map(|ws| is_workspace_writer(&ws, &who))
            .unwrap_or(false)
    }
}

mod test;
mod test_anchor;
mod test_workspace;
mod test_editor_writes;
mod test_upgrade;
