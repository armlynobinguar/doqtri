#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env,
    String, Symbol, Vec,
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
    /// The call needs the workspace's owner (admin changes).
    NotWorkspaceOwner = 8,
    /// The call needs a workspace admin or its owner (editor changes,
    /// `set_revoker`), or for `remove_editor` also the workspace's revoker.
    NotWorkspaceAdmin = 9,
    /// An `*_as` signer is neither the document's owner nor a member of the
    /// workspace the document is assigned to; `assign_document` was asked to
    /// put a document in a workspace its owner is not a member of.
    NotEditor = 10,
    /// The workspace owner's rights come from the workspace itself and can't
    /// be added or removed as a member role.
    TargetIsOwner = 11,
    /// `remove_editor` never removes an admin; the owner does that with
    /// `remove_admin`.
    TargetIsAdmin = 12,
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

/// A shared space whose members may write each other's documents. Its owner
/// is fixed at creation and holds every right in it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Workspace {
    pub owner: Address,
    pub created_at: u64,
}

/// A workspace member's role. Both may write the workspace's documents;
/// an admin may also add and remove editors and set the revoker.
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
    /// workspace_id -> `Workspace`.
    Workspace(String),
    /// (workspace_id, address) -> `Role`. The owner never has one.
    Member(String, Address),
    /// workspace_id -> the address that may only `remove_editor` there
    /// (the app's revoke-only server key).
    Revoker(String),
    /// doc_id -> workspace_id whose members may write the document.
    DocWorkspace(String),
}

/// Most node updates one `anchor` call takes, so a single transaction stays
/// well inside Soroban's resource limits.
pub const MAX_NODES_PER_CALL: u32 = 32;

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

fn member_role(env: &Env, workspace_id: &String, who: &Address) -> Option<Role> {
    let key = DataKey::Member(workspace_id.clone(), who.clone());
    let role = env.storage().persistent().get(&key);
    if role.is_some() {
        touch(env, &key);
    }
    role
}

/// Fails unless `who` is the workspace's owner or one of its admins.
fn check_workspace_admin(
    env: &Env,
    workspace_id: &String,
    ws: &Workspace,
    who: &Address,
) -> Result<(), Error> {
    if *who == ws.owner || member_role(env, workspace_id, who) == Some(Role::Admin) {
        Ok(())
    } else {
        Err(Error::NotWorkspaceAdmin)
    }
}

/// True when `who` may write the workspace's documents: its owner or any member.
fn is_workspace_writer(env: &Env, workspace_id: &String, ws: &Workspace, who: &Address) -> bool {
    *who == ws.owner || member_role(env, workspace_id, who).is_some()
}

/// Fails unless `signer` may write `doc`: its owner, or the owner or a member
/// of the workspace it is assigned to.
fn check_writer(env: &Env, doc_id: &String, doc: &Document, signer: &Address) -> Result<(), Error> {
    if *signer == doc.owner {
        return Ok(());
    }
    let ws_key = DataKey::DocWorkspace(doc_id.clone());
    let workspace_id: String = env
        .storage()
        .persistent()
        .get(&ws_key)
        .ok_or(Error::NotEditor)?;
    touch(env, &ws_key);
    let ws = load_workspace(env, &workspace_id)?;
    if is_workspace_writer(env, &workspace_id, &ws, signer) {
        Ok(())
    } else {
        Err(Error::NotEditor)
    }
}

/// Publishes a document event. The owner-only calls keep their original
/// two-topic shape; the `*_as` calls add the signer as a third topic so an
/// indexer can tell who wrote, and filter by it.
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

/// Publishes a workspace event: value is (workspace_id, subject, caller).
fn publish_ws_event(
    env: &Env,
    action: Symbol,
    workspace_id: &String,
    subject: &Address,
    caller: &Address,
) {
    env.events().publish(
        (symbol_short!("doqtri"), action),
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
    let mut doc = match load_doc(env, &doc_id) {
        Ok(doc) => {
            if as_signer {
                check_writer(env, &doc_id, &doc, &signer)?;
            } else if doc.owner != signer {
                return Err(Error::NotOwner);
            }
            doc
        }
        Err(_) => {
            publish_doc_event(env, symbol_short!("register"), event_signer, &doc_id);
            Document {
                owner: signer.clone(),
                content_hash: content_hash.clone(),
                version: 1,
                node_count: 0,
                updated_at: now,
            }
        }
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
    /// Only the document owner may call. Returns the new version number.
    pub fn update_document(
        env: Env,
        doc_id: String,
        new_hash: BytesN<32>,
    ) -> Result<u32, Error> {
        let key = DataKey::Doc(doc_id.clone());
        let mut doc: Document = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::DocumentNotFound)?;

        doc.owner.require_auth();

        doc.content_hash = new_hash;
        doc.version += 1;
        doc.updated_at = env.ledger().timestamp();

        env.storage().persistent().set(&key, &doc);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);

        // Emit doc_id (not version) — matches register/node and web chain-sync.
        env.events()
            .publish((symbol_short!("doqtri"), symbol_short!("update")), doc_id);
        Ok(doc.version)
    }

    /// Record or update the build status of a mindmap node.
    /// `tool` is the builder used (e.g. "n8n"); `artifact_ref` points to the
    /// built artifact (workflow ID, URL, or hash). Owner-only.
    pub fn set_node_status(
        env: Env,
        doc_id: String,
        node_id: String,
        status: NodeStatus,
        tool: String,
        artifact_ref: String,
    ) -> Result<(), Error> {
        let doc_key = DataKey::Doc(doc_id.clone());
        let mut doc: Document = env
            .storage()
            .persistent()
            .get(&doc_key)
            .ok_or(Error::DocumentNotFound)?;

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

        // Emit doc_id so vault sync can refresh the parent plan (node details via get_node).
        env.events()
            .publish((symbol_short!("doqtri"), symbol_short!("node")), doc_id);
        Ok(())
    }

    /// Fetch a document's anchored state.
    pub fn get_document(env: Env, doc_id: String) -> Result<Document, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Doc(doc_id))
            .ok_or(Error::DocumentNotFound)
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
    // admins and the owner manage editors and the revoker; every member may
    // write the documents assigned to the workspace. The revoker is a
    // server key that may only `remove_editor`, so a member removed in the
    // app loses chain access at once without waiting for an admin to sign.
    //
    // The owner-only calls above are unchanged: workspace writes go through
    // the `*_as` calls, which name their signer.

    /// Creates a workspace owned by `owner`. Fails if the id is taken.
    pub fn create_workspace(env: Env, workspace_id: String, owner: Address) -> Result<(), Error> {
        owner.require_auth();
        let key = DataKey::Workspace(workspace_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::WorkspaceAlreadyExists);
        }
        let ws = Workspace {
            owner: owner.clone(),
            created_at: env.ledger().timestamp(),
        };
        persist(&env, &key, &ws);
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
        let ws = load_workspace(&env, &workspace_id)?;
        if owner != ws.owner {
            return Err(Error::NotWorkspaceOwner);
        }
        if admin == ws.owner {
            return Err(Error::TargetIsOwner);
        }
        persist(
            &env,
            &DataKey::Member(workspace_id.clone(), admin.clone()),
            &Role::Admin,
        );
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
    /// editor, `add_editor` them after). Owner only. Returns false, changing
    /// nothing, when `admin` is not an admin.
    pub fn remove_admin(
        env: Env,
        workspace_id: String,
        owner: Address,
        admin: Address,
    ) -> Result<bool, Error> {
        owner.require_auth();
        let ws = load_workspace(&env, &workspace_id)?;
        if owner != ws.owner {
            return Err(Error::NotWorkspaceOwner);
        }
        if admin == ws.owner {
            return Err(Error::TargetIsOwner);
        }
        let key = DataKey::Member(workspace_id.clone(), admin.clone());
        if env.storage().persistent().get::<_, Role>(&key) != Some(Role::Admin) {
            return Ok(false);
        }
        env.storage().persistent().remove(&key);
        publish_ws_event(
            &env,
            symbol_short!("admin_rm"),
            &workspace_id,
            &admin,
            &owner,
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
        let ws = load_workspace(&env, &workspace_id)?;
        check_workspace_admin(&env, &workspace_id, &ws, &admin)?;
        if editor == ws.owner {
            return Err(Error::TargetIsOwner);
        }
        let key = DataKey::Member(workspace_id.clone(), editor.clone());
        if env.storage().persistent().has(&key) {
            touch(&env, &key);
            return Ok(());
        }
        persist(&env, &key, &Role::Editor);
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
    /// admin, the owner, or the workspace's revoker. Never removes an admin
    /// or the owner. Returns false, changing nothing, when `editor` is not a
    /// member, so a retried removal still succeeds.
    pub fn remove_editor(
        env: Env,
        workspace_id: String,
        caller: Address,
        editor: Address,
    ) -> Result<bool, Error> {
        caller.require_auth();
        let ws = load_workspace(&env, &workspace_id)?;
        let revoker: Option<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Revoker(workspace_id.clone()));
        if revoker.as_ref() != Some(&caller) {
            check_workspace_admin(&env, &workspace_id, &ws, &caller)?;
        }
        if editor == ws.owner {
            return Err(Error::TargetIsOwner);
        }
        let key = DataKey::Member(workspace_id.clone(), editor.clone());
        match env.storage().persistent().get::<_, Role>(&key) {
            None => Ok(false),
            Some(Role::Admin) => Err(Error::TargetIsAdmin),
            Some(Role::Editor) => {
                env.storage().persistent().remove(&key);
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

    /// Sets (or replaces) the workspace's revoker, the one address besides
    /// admins and the owner that may `remove_editor`, and nothing else.
    /// `admin` must be a workspace admin or the owner.
    pub fn set_revoker(
        env: Env,
        workspace_id: String,
        admin: Address,
        revoker: Address,
    ) -> Result<(), Error> {
        admin.require_auth();
        let ws = load_workspace(&env, &workspace_id)?;
        check_workspace_admin(&env, &workspace_id, &ws, &admin)?;
        persist(&env, &DataKey::Revoker(workspace_id.clone()), &revoker);
        publish_ws_event(
            &env,
            symbol_short!("revoker"),
            &workspace_id,
            &revoker,
            &admin,
        );
        Ok(())
    }

    /// Puts a document in a workspace, so the workspace's members may write
    /// it through the `*_as` calls; a document already in one moves. The
    /// document's owner signs and must be a member (or the owner) of the
    /// workspace. The document keeps its owner.
    pub fn assign_document(env: Env, doc_id: String, workspace_id: String) -> Result<(), Error> {
        let doc = load_doc(&env, &doc_id)?;
        doc.owner.require_auth();
        let ws = load_workspace(&env, &workspace_id)?;
        if !is_workspace_writer(&env, &workspace_id, &ws, &doc.owner) {
            return Err(Error::NotEditor);
        }
        persist(&env, &DataKey::DocWorkspace(doc_id.clone()), &workspace_id);
        env.events().publish(
            (symbol_short!("doqtri"), symbol_short!("assign")),
            (doc_id, workspace_id),
        );
        Ok(())
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
        let mut doc = load_doc(&env, &doc_id)?;
        check_writer(&env, &doc_id, &doc, &signer)?;

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
        let mut doc = load_doc(&env, &doc_id)?;
        check_writer(&env, &doc_id, &doc, &signer)?;

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
    /// puts it in a workspace. `signer` must sign.
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

    /// A workspace's owner and creation time.
    pub fn get_workspace(env: Env, workspace_id: String) -> Result<Workspace, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Workspace(workspace_id))
            .ok_or(Error::WorkspaceNotFound)
    }

    /// `who`'s member role in the workspace; none for the owner and for
    /// non-members.
    pub fn get_role(env: Env, workspace_id: String, who: Address) -> Option<Role> {
        env.storage()
            .persistent()
            .get(&DataKey::Member(workspace_id, who))
    }

    /// The workspace's revoker, if one is set.
    pub fn get_revoker(env: Env, workspace_id: String) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::Revoker(workspace_id))
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
        let ws: Option<Workspace> = env
            .storage()
            .persistent()
            .get(&DataKey::Workspace(workspace_id.clone()));
        match ws {
            Some(ws) => {
                who == ws.owner
                    || env
                        .storage()
                        .persistent()
                        .has(&DataKey::Member(workspace_id, who))
            }
            None => false,
        }
    }
}

mod test;
mod test_anchor;
mod test_workspace;
mod test_editor_writes;
