/**
 * Ledger-backed history for one DoqtriRegistry document.
 *
 * The contract only stores the *latest* hash and version, and its events carry
 * nothing but `doc_id` — and RPC drops events after about a week anyway. The
 * full record survives in Horizon: every `invoke_host_function` operation keeps
 * its contract, function name and arguments forever. So history is rebuilt by
 * reading the owner's operations and decoding the arguments.
 *
 * Freighter-style owners (`G…`) submit their own writes, so the owner's
 * operation feed contains all of them. Passkey smart wallets (`C…`) cannot be a
 * transaction source: the relay submits their writes from shared Channels
 * accounts, and Horizon has no feed for a contract address. For those, the
 * relay's index (`chain_writes`) lists which transactions to read, and each one
 * is still read from Horizon and decoded here — the index only says where to
 * look, so a bogus row cannot add a version that is not on the ledger.
 *
 * A note in a workspace (registry v3, WP-1.4) is written by its members, not
 * only its owner, so its history is the owner's feed and the index together:
 * a `G…` owner's feed has none of the editors' passkey writes, and the index
 * none of the owner's own. An editor's Freighter write is in neither; the
 * registry's `*_as` events name their signer in a topic (WP-1.3), so the RPC's
 * event window (about a week) says which transactions to read for those, and
 * the feeds of signers the workspace removed (passed in by the caller, which
 * reads them from doqtri's database) cover the writes the audit page most
 * needs to show: ones made after a removal (WP-1.8). Older Freighter writes
 * by current editors can still be missing; the version count then marks such
 * a history incomplete rather than numbering it wrong. Every source only says
 * where to look: each write is read from Horizon and decoded here.
 *
 * Every entry names the wallet that signed it (WP-1.8). The `*_as` calls,
 * `register_document` and `anchor` carry their signer as their first
 * argument, the same address the contract required auth from and the
 * `*_as` events put in their topic. The owner-only `update_document` and
 * `set_node_status` name nobody; the contract requires the document owner's
 * signature for them, so they are attributed to the owner (`signerFrom:
 * "owner"`). With REGISTRY_EDITORS off every write is owner-only and history
 * is read exactly as before.
 */
import { createClient } from "@supabase/supabase-js";
import { Address, rpc, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { CONTRACT_ID, HORIZON_URL, LEGACY_CONTRACT_IDS, REGISTRY_EDITORS, RPC_URL } from "@/lib/stellar/config";
import { docLedgerKey } from "@/lib/stellar/anchored";
import { DoqtriRegistry } from "@/lib/stellar/contract-client";
import { FEE_FORWARDER, NETWORK } from "@/lib/stellar/smart-wallet-config";

/**
 * Where an entry's signer comes from: the call itself names it ("call"), or
 * the call is owner-only and names nobody, so it is the owner ("owner").
 */
export type SignerSource = "call" | "owner";

export type ChainVersion = {
  version: number;
  contentHash: string;
  txHash: string;
  closedAt: string;
  /** The wallet that signed this write. */
  signer: string;
  signerFrom: SignerSource;
};

export type ChainNodeEvent = {
  nodeId: string;
  status: string;
  tool: string;
  artifactRef: string;
  txHash: string;
  closedAt: string;
  /** The document version in effect when this status was recorded. */
  docVersion: number;
  /** The wallet that signed this write. */
  signer: string;
  signerFrom: SignerSource;
};

export type DocumentHistory = {
  owner: string;
  versions: ChainVersion[];
  nodeEvents: ChainNodeEvent[];
  /** Latest event per node id, in first-seen order. */
  nodes: ChainNodeEvent[];
  /**
   * Set when the contract reports more versions than were found — possible
   * for passkey-wallet owners, whose history comes from Doqtri's index (a
   * write made outside Doqtri, or one the index missed), and for workspace
   * notes an editor wrote from Freighter (not indexed). Version numbers
   * are then not trustworthy and should not be shown as such.
   */
  incomplete?: true;
};

/** The subset of a Horizon operation record this module reads. */
export type HorizonOperation = {
  type: string;
  /** Total order across the ledger: ledger, transaction, operation. */
  paging_token?: string;
  transaction_successful?: boolean;
  transaction_hash: string;
  created_at: string;
  parameters?: { type: string; value: string }[];
};

/**
 * One registry write. `signer` is set when the call names who signed it
 * (its first argument); the owner-only update_document and set_node_status
 * leave it out.
 */
type Invocation = (
  | { fn: "register_document"; docId: string; hash: string }
  | { fn: "update_document"; docId: string; hash: string }
  | {
      fn: "set_node_status";
      docId: string;
      nodeId: string;
      status: string;
      tool: string;
      artifactRef: string;
    }
  | {
      fn: "anchor";
      docId: string;
      hash: string;
      nodes: { nodeId: string; status: string; tool: string; artifactRef: string }[];
    }
) & { signer?: string };

function decode(value: string): xdr.ScVal {
  return xdr.ScVal.fromXDR(value, "base64");
}

function toHex(bytes: unknown): string {
  if (bytes instanceof Uint8Array) return Buffer.from(bytes).toString("hex");
  return String(bytes);
}

/** A unit enum variant arrives as `["Built"]` from scValToNative. */
function enumTag(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? "Unknown");
  return String(value ?? "Unknown");
}

/**
 * Decodes one operation into a DoqtriRegistry call on `contractId`, or null
 * when it is anything else. Malformed parameters are treated as "not ours"
 * rather than thrown, since the feed contains every operation the owner made.
 */
export function decodeInvocation(
  op: HorizonOperation,
  contractId: string | readonly string[],
  forwarder: string | null = FEE_FORWARDER,
): Invocation | null {
  const registries: readonly string[] = typeof contractId === "string" ? [contractId] : contractId;
  if (op.type !== "invoke_host_function") return null;
  if (op.transaction_successful === false) return null;
  const params = op.parameters;
  if (!params || params.length < 2) return null;

  try {
    const contract = Address.fromScVal(decode(params[0].value)).toString();
    let fn = String(scValToNative(decode(params[1].value)));
    let args: unknown[];
    if (registries.includes(contract)) {
      args = params.slice(2).map((p) => scValToNative(decode(p.value)));
    } else if (forwarder && contract === forwarder && fn === "forward" && params.length >= 9) {
      // A user-paid write (progress/003): forward(fee_token, fee_amount,
      // max_fee_amount, expiration_ledger, target, target_fn, target_args, …).
      // The registry call is the wrapped one.
      if (!registries.includes(Address.fromScVal(decode(params[6].value)).toString())) return null;
      fn = String(scValToNative(decode(params[7].value)));
      args = (decode(params[8].value).vec() ?? []).map((v) => scValToNative(v));
    } else {
      return null;
    }

    switch (fn) {
      // register_document(owner, doc_id, content_hash)
      case "register_document":
        return { fn, docId: String(args[1]), hash: toHex(args[2]), signer: String(args[0]) };
      // update_document(doc_id, new_hash)
      case "update_document":
        return { fn, docId: String(args[0]), hash: toHex(args[1]) };
      // set_node_status(doc_id, node_id, status, tool, artifact_ref)
      case "set_node_status":
        return {
          fn,
          docId: String(args[0]),
          nodeId: String(args[1]),
          status: enumTag(args[2]),
          tool: String(args[3] ?? ""),
          artifactRef: String(args[4] ?? ""),
        };
      // The *_as writes (registry v3, WP-1.4) are the same writes with the
      // signer first; history folds them in like the owner-only ones.
      // update_document_as(signer, doc_id, new_hash)
      case "update_document_as":
        return { fn: "update_document", docId: String(args[1]), hash: toHex(args[2]), signer: String(args[0]) };
      // set_node_status_as(signer, doc_id, node_id, status, tool, artifact_ref)
      case "set_node_status_as":
        return {
          fn: "set_node_status",
          docId: String(args[1]),
          nodeId: String(args[2]),
          status: enumTag(args[3]),
          tool: String(args[4] ?? ""),
          artifactRef: String(args[5] ?? ""),
          signer: String(args[0]),
        };
      // anchor(owner, doc_id, content_hash, nodes); anchor_as(signer, …) alike
      case "anchor":
      case "anchor_as":
        return {
          fn: "anchor",
          docId: String(args[1]),
          hash: toHex(args[2]),
          nodes: ((args[3] as Record<string, unknown>[] | undefined) ?? []).map((n) => ({
            nodeId: String(n.node_id),
            status: enumTag(n.status),
            tool: String(n.tool ?? ""),
            artifactRef: String(n.artifact_ref ?? ""),
          })),
          signer: String(args[0]),
        };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Folds an owner's operations (oldest first) into one document's history.
 * Versions are numbered by order, matching the contract: register is v1 and
 * each update adds one.
 */
export function buildHistory(
  ops: HorizonOperation[],
  docId: string,
  contractId: string | readonly string[],
  owner: string,
): DocumentHistory {
  const versions: ChainVersion[] = [];
  const nodeEvents: ChainNodeEvent[] = [];

  for (const op of ops) {
    const call = decodeInvocation(op, contractId);
    if (!call || call.docId !== docId) continue;
    const signed = call.signer
      ? { signer: call.signer, signerFrom: "call" as const }
      : { signer: owner, signerFrom: "owner" as const };

    if (call.fn === "anchor") {
      // Like the contract: a new document is v1, changed text a new version,
      // the same text keeps its version; then every node update.
      const last = versions[versions.length - 1];
      if (!last || last.contentHash !== call.hash) {
        versions.push({
          version: versions.length + 1,
          contentHash: call.hash,
          txHash: op.transaction_hash,
          closedAt: op.created_at,
          ...signed,
        });
      }
      for (const node of call.nodes) {
        nodeEvents.push({
          ...node,
          txHash: op.transaction_hash,
          closedAt: op.created_at,
          docVersion: versions.length,
          ...signed,
        });
      }
    } else if (call.fn === "register_document" || call.fn === "update_document") {
      // A second register cannot succeed on-chain; ignore one if it appears.
      if (call.fn === "register_document" && versions.length > 0) continue;
      versions.push({
        version: versions.length + 1,
        contentHash: call.hash,
        txHash: op.transaction_hash,
        closedAt: op.created_at,
        ...signed,
      });
    } else {
      nodeEvents.push({
        nodeId: call.nodeId,
        status: call.status,
        tool: call.tool,
        artifactRef: call.artifactRef,
        txHash: op.transaction_hash,
        closedAt: op.created_at,
        docVersion: versions.length,
        ...signed,
      });
    }
  }

  const latest = new Map<string, ChainNodeEvent>();
  for (const event of nodeEvents) {
    latest.delete(event.nodeId);
    latest.set(event.nodeId, event);
  }
  // Re-sort into first-seen order so a status change does not reshuffle rows.
  const firstSeen = [...new Set(nodeEvents.map((e) => e.nodeId))];
  const nodes = firstSeen.map((id) => latest.get(id)!);

  return { owner, versions, nodeEvents, nodes };
}

/** This registry and the ones its documents were migrated from. */
const REGISTRIES: readonly string[] = [CONTRACT_ID, ...LEGACY_CONTRACT_IDS];

/** Horizon caps a page at 200; this bounds a runaway feed. */
const MAX_PAGES = 25;

async function fetchOwnerOperations(owner: string): Promise<HorizonOperation[]> {
  const ops: HorizonOperation[] = [];
  let url: string | undefined =
    `${HORIZON_URL}/accounts/${owner}/operations?order=asc&limit=200`;

  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res: Response = await fetch(url);
    if (!res.ok) throw new Error(`Horizon error (${res.status})`);
    const body = (await res.json()) as {
      _embedded?: { records?: HorizonOperation[] };
      _links?: { next?: { href?: string } };
    };
    const records = body._embedded?.records ?? [];
    ops.push(...records);
    url = records.length > 0 ? body._links?.next?.href : undefined;
  }

  return ops;
}

/** Operations from separate transactions, oldest first (paging tokens are ledger order). */
export function inLedgerOrder(ops: HorizonOperation[]): HorizonOperation[] {
  const key = (op: HorizonOperation) => {
    try {
      return BigInt(op.paging_token ?? "0");
    } catch {
      return BigInt(0);
    }
  };
  return [...ops].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Two operation lists as one, oldest first, each operation once (by its id, the paging token). */
export function mergeOperations(...lists: HorizonOperation[][]): HorizonOperation[] {
  const seen = new Map<string, HorizonOperation>();
  for (const op of lists.flat()) {
    const key = op.paging_token ?? `${op.transaction_hash}:${seen.size}`;
    if (!seen.has(key)) seen.set(key, op);
  }
  return inLedgerOrder([...seen.values()]);
}

/** Marks a history that found fewer versions than the contract has. */
export function withCompleteness(history: DocumentHistory, contractVersion: number): DocumentHistory {
  return history.versions.length === contractVersion ? history : { ...history, incomplete: true };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bounds the Horizon calls for one page view. */
const MAX_INDEXED_WRITES = 200;
const HORIZON_BATCH = 10;

/** Each transaction's operations from Horizon, oldest first. Unknown hashes are skipped. */
async function fetchTransactionOperations(hashes: readonly string[]): Promise<HorizonOperation[]> {
  const ops: HorizonOperation[] = [];
  for (let i = 0; i < hashes.length; i += HORIZON_BATCH) {
    const batch = await Promise.all(
      hashes.slice(i, i + HORIZON_BATCH).map(async (hash) => {
        const res = await fetch(`${HORIZON_URL}/transactions/${hash}/operations?limit=10`);
        // Not on this network's Horizon: not a write we can show.
        if (res.status === 404) return [];
        if (!res.ok) throw new Error(`Horizon error (${res.status})`);
        const body = (await res.json()) as { _embedded?: { records?: HorizonOperation[] } };
        return body._embedded?.records ?? [];
      }),
    );
    ops.push(...batch.flat());
  }
  return inLedgerOrder(ops);
}

/** Relayed writes for a passkey-wallet document: index lookup, then Horizon. */
async function fetchIndexedOperations(docId: string): Promise<HorizonOperation[]> {
  if (!UUID.test(docId)) return [];
  // chain_writes is publicly readable (it mirrors ledger data), so the anon
  // key works the same on the public audit page and in the vault.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await supabase
    .from("chain_writes")
    .select("tx_hash")
    .eq("network", NETWORK)
    .eq("document_id", docId)
    .order("created_at", { ascending: true })
    .limit(MAX_INDEXED_WRITES);
  if (error) throw new Error(`Write index unavailable: ${error.message}`);

  return fetchTransactionOperations((data ?? []).map((row) => row.tx_hash as string));
}

/** The subset of an RPC contract event this module reads. */
export type RegistryEvent = Pick<rpc.Api.EventResponse, "topic" | "value" | "txHash" | "inSuccessfulContractCall">;

/**
 * Transactions that wrote `docId` through a `*_as` call, from the registry's
 * events. Those events have three topics, `("doqtri", action, signer)`, and
 * the doc_id as their value; the owner-only calls' two-topic events, and the
 * `doqtri_ws` membership events, are not theirs. Returns each transaction
 * once, in event order, with the signer its event named.
 */
export function signedWriteTransactions(events: readonly RegistryEvent[], docId: string): { txHash: string; signer: string }[] {
  const found = new Map<string, string>();
  for (const event of events) {
    if (event.inSuccessfulContractCall === false || event.topic.length !== 3) continue;
    try {
      if (scValToNative(event.topic[0]) !== "doqtri") continue;
      if (String(scValToNative(event.value)) !== docId) continue;
      const signer = Address.fromScVal(event.topic[2]).toString();
      if (!found.has(event.txHash)) found.set(event.txHash, signer);
    } catch {
      // Not shaped like ours.
    }
  }
  return [...found].map(([txHash, signer]) => ({ txHash, signer }));
}

/** Bounds one page view's event scan: RPC pages of up to 1000 events. */
const EVENT_PAGE = 1000;
const MAX_EVENT_PAGES = 10;

/**
 * The `*_as` writes of `docId` still inside the RPC's event window (about a
 * week), wherever they were submitted from: this is how an editor's own
 * Freighter writes, which no feed Doqtri reads contains, reach history.
 * Events only say where to look; each transaction is read from Horizon.
 */
async function fetchEventOperations(docId: string): Promise<HorizonOperation[]> {
  const server = new rpc.Server(RPC_URL);
  const { oldestLedger } = await server.getHealth();
  const filters: rpc.Api.EventFilter[] = [
    {
      type: "contract",
      contractIds: [CONTRACT_ID],
      topics: [[xdr.ScVal.scvSymbol("doqtri").toXDR("base64"), "*", "*"]],
    },
  ];
  const events: RegistryEvent[] = [];
  // The window's oldest ledger moves on as ledgers close; start a little
  // inside it so the first request is not refused as out of range.
  let page = await server.getEvents({ filters, startLedger: oldestLedger + 10, limit: EVENT_PAGE });
  for (let n = 1; ; n++) {
    events.push(...page.events);
    if (page.events.length < EVENT_PAGE || n >= MAX_EVENT_PAGES) break;
    page = await server.getEvents({ filters, cursor: page.cursor, limit: EVENT_PAGE });
  }
  return fetchTransactionOperations(signedWriteTransactions(events, docId).map((w) => w.txHash));
}

/** A removed member's `G…` feed is read back to their removal, at most this many pages. */
const MAX_SINCE_PAGES = 5;

/** An account's operations from `since` on, oldest first. */
async function fetchAccountOperationsSince(account: string, since: string): Promise<HorizonOperation[]> {
  const ops: HorizonOperation[] = [];
  const from = Date.parse(since);
  let url: string | undefined = `${HORIZON_URL}/accounts/${account}/operations?order=desc&limit=200`;
  for (let page = 0; url && page < MAX_SINCE_PAGES; page++) {
    const res: Response = await fetch(url);
    // An account that was never funded has no feed.
    if (res.status === 404) break;
    if (!res.ok) throw new Error(`Horizon error (${res.status})`);
    const body = (await res.json()) as {
      _embedded?: { records?: HorizonOperation[] };
      _links?: { next?: { href?: string } };
    };
    const records = body._embedded?.records ?? [];
    const recent = records.filter((op) => Date.parse(op.created_at) >= from);
    ops.push(...recent);
    url = records.length > 0 && recent.length === records.length ? body._links?.next?.href : undefined;
  }
  return inLedgerOrder(ops);
}

/** A wallet the document's workspace removed, and since when; from doqtri's database. */
export type RemovedSigner = { address: string; removedAt: string };

export type HistoryOptions = {
  /**
   * Signers whose writes after their removal must not be missed. Their
   * Freighter (`G…`) feeds are read back to the earliest removal; passkey
   * wallets have no feed and rely on the index and the events.
   */
  removedSigners?: readonly RemovedSigner[];
};

/** Each `G…` address once, with its earliest removal. */
function removedAccounts(signers: readonly RemovedSigner[]): RemovedSigner[] {
  const earliest = new Map<string, string>();
  for (const { address, removedAt } of signers) {
    if (!StrKey.isValidEd25519PublicKey(address)) continue;
    const seen = earliest.get(address);
    if (!seen || Date.parse(removedAt) < Date.parse(seen)) earliest.set(address, removedAt);
  }
  return [...earliest].map(([address, removedAt]) => ({ address, removedAt }));
}

/**
 * Full history for `docId`, or null when it is not anchored. Throws on
 * transport errors, so callers can tell "not anchored" from "ledger down".
 */
export async function getDocumentHistory(
  docId: string,
  options: HistoryOptions = {},
): Promise<DocumentHistory | null> {
  const doc = await DoqtriRegistry.readDocument(docId);
  if (!doc?.owner) return null;
  const passkeyOwner = StrKey.isValidContract(doc.owner);
  // Only the v3 registry has workspaces; the live one has no get_doc_workspace.
  const workspace = REGISTRY_EDITORS ? await DoqtriRegistry.readDocWorkspace(docId).catch(() => null) : null;
  if (!workspace) {
    if (passkeyOwner) {
      const ops = await fetchIndexedOperations(docId);
      return withCompleteness(buildHistory(ops, docId, REGISTRIES, doc.owner), doc.version);
    }
    const ops = await fetchOwnerOperations(doc.owner);
    return buildHistory(ops, docId, REGISTRIES, doc.owner);
  }
  // A workspace note: its owner's feed (a passkey owner has none), the
  // index, and then the events and removed members' feeds, which only add
  // writes; when those are unreachable history is what the first two hold,
  // and the version count says if that is short.
  const [ownerOps, indexed, evented, ...removed] = await Promise.all([
    passkeyOwner ? [] : fetchOwnerOperations(doc.owner),
    fetchIndexedOperations(docId),
    fetchEventOperations(docId).catch(() => []),
    ...removedAccounts(options.removedSigners ?? [])
      .filter((r) => r.address !== doc.owner)
      .map((r) => fetchAccountOperationsSince(r.address, r.removedAt).catch(() => [])),
  ]);
  const ops = mergeOperations(ownerOps, indexed, evented, ...removed);
  return withCompleteness(buildHistory(ops, docId, REGISTRIES, doc.owner), doc.version);
}

export type DocumentTtl = {
  liveUntilLedger: number;
  latestLedger: number;
  /** Approximate, from an average ledger close time. */
  expiresAt: Date;
};

/** Stellar closes a ledger roughly every 5–6 seconds. */
const SECONDS_PER_LEDGER = 5.5;

/**
 * When the document's persistent entry is due to be archived. Null when the
 * entry is not found.
 */
export async function getDocumentTtl(docId: string): Promise<DocumentTtl | null> {
  const server = new rpc.Server(RPC_URL);
  const { entries, latestLedger } = await server.getLedgerEntries(
    docLedgerKey(docId),
  );
  const entry = entries[0];
  if (!entry?.liveUntilLedgerSeq) return null;

  const ledgersLeft = entry.liveUntilLedgerSeq - latestLedger;
  return {
    liveUntilLedger: entry.liveUntilLedgerSeq,
    latestLedger,
    expiresAt: new Date(Date.now() + ledgersLeft * SECONDS_PER_LEDGER * 1000),
  };
}
