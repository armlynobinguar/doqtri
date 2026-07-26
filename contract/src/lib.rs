#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env,
    String,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    DocumentAlreadyExists = 1,
    DocumentNotFound = 2,
    NodeNotFound = 3,
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

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Doc(String),
    Node(String, String),
}

const DAY_IN_LEDGERS: u32 = 17280;
const TTL_THRESHOLD: u32 = DAY_IN_LEDGERS * 30;
const TTL_EXTEND: u32 = DAY_IN_LEDGERS * 90;

#[contract]
pub struct DoqtriRegistry;

#[contractimpl]
impl DoqtriRegistry {
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
