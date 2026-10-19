#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env,
    String, Vec,
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

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Doc(String),
    Node(String, String),
    /// Who may `upgrade` the contract and `import_*` documents (instance storage).
    Admin,
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

        let now = env.ledger().timestamp();
        let mut doc = match load_doc(&env, &doc_id) {
            Ok(doc) => {
                if doc.owner != owner {
                    return Err(Error::NotOwner);
                }
                doc
            }
            Err(_) => {
                env.events().publish(
                    (symbol_short!("doqtri"), symbol_short!("register")),
                    doc_id.clone(),
                );
                Document {
                    owner,
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
            env.events().publish(
                (symbol_short!("doqtri"), symbol_short!("update")),
                doc_id.clone(),
            );
        }

        for update in nodes.iter() {
            let record = NodeRecord {
                status: update.status,
                tool: update.tool,
                artifact_ref: update.artifact_ref,
                updated_at: now,
            };
            if store_node(&env, &doc_id, update.node_id, &record) {
                doc.node_count += 1;
            }
        }
        if !nodes.is_empty() {
            env.events()
                .publish((symbol_short!("doqtri"), symbol_short!("node")), doc_id.clone());
        }

        store_doc(&env, &doc_id, &doc);
        Ok(doc.version)
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
}

mod test;
mod test_anchor;
