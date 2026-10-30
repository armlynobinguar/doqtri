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
 * needs to show: ones made after a removal (WP-1.8), for a day, or for as
 * long as the chain still lists them or until their revocation reached it
 * (WP-1.10). Older Freighter writes
 * by current editors can still be missing; the version count then marks such
 * a history incomplete rather than numbering it wrong. Every source only says
 * where to look: each write is read from Horizon and decoded here.
 *
 * The owner's feed and the index are the owner's own writes. The events and
 * the removed members' feeds are not: anyone can call any registry, so they
 * are kept only as evidence of the named signer's own writes on this
 * registry (a `*_as` call whose signer is the event's, or the feed's, own
 * address). Anything else they hold, such as a third party's owner-only call
 * on a legacy registry for this doc id, never reaches history.
 *
 * Every entry names the wallet that signed it (WP-1.8). The `*_as` calls,
 * `register_document` and `anchor` carry their signer as their first
 * argument, the same address the contract required auth from and the
 * `*_as` events put in their topic. The owner-only `update_document` and
 * `set_node_status` name nobody: the contract requires the signature of
 * whoever owned the note *then*, and a workspace note's owner changes with
 * the workspace's (D-28, D-29). Their signer is read from the transaction's
 * auth entries (`signerFrom: "owner"`); when those cannot be read it is the
 * current owner only on a registry where ownership never moves
 * (REGISTRY_EDITORS off), and otherwise left unnamed (`signer: null`) rather
 * than credited to a wallet that may never have signed it. With
 * REGISTRY_EDITORS off history is read exactly as before.
 */
import { createClient } from "@supabase/supabase-js";
import { Address, rpc, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { CONTRACT_ID, HORIZON_URL, LEGACY_CONTRACT_IDS, REGISTRY_EDITORS, RPC_URL } from "@/lib/stellar/config";
import { docLedgerKey } from "@/lib/stellar/anchored";
import { DoqtriRegistry } from "@/lib/stellar/contract-client";
import { FEE_FORWARDER, NETWORK } from "@/lib/stellar/smart-wallet-config";
import { chainRoleOf, type ChainWorkspace } from "@/lib/stellar/workspace-chain";

/**
 * Where an entry's signer comes from: the call itself names it ("call"), or
 * the call is owner-only, so it is whoever owned the note at the time
 * ("owner").
 */
export type SignerSource = "call" | "owner";

export type ChainVersion = {
  version: number;
  contentHash: string;
  txHash: string;
  closedAt: string;
  /**
   * The wallet that signed this write; null for an owner-only write whose
   * signer could not be read, which the note's owner at the time signed.
   */
  signer: string | null;
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
  /** As for ChainVersion. */
  signer: string | null;
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
  /**
   * Set when a bounded read (the registry's event window, or a removed
   * signer's feed after their removal) stopped before its end, or the
   * chain could not say whether a removed signer is still on the
   * workspace's editor list, so an editor's write can be missing even when
   * the version count matches: a build status has no count to check.
   */
  partial?: true;
  /** The note's on-chain workspace, when it is in one (registry v3). */
  workspace?: string;
};

/** The subset of a Horizon operation record this module reads. */
export type HorizonOperation = {
  type: string;
  /** Total order across the ledger: ledger, transaction, operation. */
  paging_token?: string;
  transaction_successful?: boolean;
  transaction_hash: string;
  created_at: string;
  /** The operation's source, or its transaction's. */
  source_account?: string;
  parameters?: { type: string; value: string }[];
  /** With `join=transactions`: the transaction holding this operation. */
  transaction?: { envelope_xdr?: string };
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

/** True when `invocation`, or one it makes, is `fn(docId, …)` on one of `registries`. */
function invokes(
  invocation: xdr.SorobanAuthorizedInvocation,
  fn: string,
  docId: string,
  registries: readonly string[],
): boolean {
  const target = invocation.function();
  if (target.switch().name === "sorobanAuthorizedFunctionTypeContractFn") {
    const call = target.contractFn();
    const args = call.args();
    if (
      registries.includes(Address.fromScAddress(call.contractAddress()).toString()) &&
      call.functionName().toString() === fn &&
      args.length > 0 &&
      String(scValToNative(args[0])) === docId
    ) {
      return true;
    }
  }
  return invocation.subInvocations().some((sub) => invokes(sub, fn, docId, registries));
}

/**
 * The wallet that authorized the owner-only `fn(docId, …)` in `op`'s
 * transaction: the address of the auth entry that covers that call (a
 * forwarded write's covers it as a sub-invocation), or the operation's
 * source for source-account auth. Null when the transaction is not at hand
 * (no `join=transactions`) or the entries do not name exactly one wallet,
 * so an unused extra entry cannot pick the signer.
 */
export function ownerAuthorizer(
  op: HorizonOperation,
  fn: string,
  docId: string,
  registries: readonly string[],
): string | null {
  const envelope = op.transaction?.envelope_xdr;
  if (!envelope) return null;
  try {
    const parsed = xdr.TransactionEnvelope.fromXDR(envelope, "base64");
    const kind = parsed.switch().name;
    const tx =
      kind === "envelopeTypeTxFeeBump"
        ? parsed.feeBump().tx().innerTx().v1().tx()
        : kind === "envelopeTypeTx"
          ? parsed.v1().tx()
          : null;
    if (!tx) return null;
    const found = new Set<string>();
    for (const operation of tx.operations()) {
      if (operation.body().switch().name !== "invokeHostFunction") continue;
      for (const entry of operation.body().invokeHostFunctionOp().auth()) {
        if (!invokes(entry.rootInvocation(), fn, docId, registries)) continue;
        const credentials = entry.credentials();
        if (credentials.switch().name === "sorobanCredentialsAddress") {
          found.add(Address.fromScAddress(credentials.address().address()).toString());
        } else if (op.source_account) {
          found.add(op.source_account);
        } else {
          return null;
        }
      }
    }
    return found.size === 1 ? [...found][0] : null;
  } catch {
    return null;
  }
}

export type BuildOptions = {
  /**
   * The registry has no way to move a document to another owner (no
   * workspaces: REGISTRY_EDITORS off), so an owner-only write whose auth
   * cannot be read was the current owner's. Otherwise such a write is left
   * unnamed.
   */
  fixedOwner?: boolean;
};

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
  { fixedOwner = false }: BuildOptions = {},
): DocumentHistory {
  const registries: readonly string[] = typeof contractId === "string" ? [contractId] : contractId;
  const versions: ChainVersion[] = [];
  const nodeEvents: ChainNodeEvent[] = [];

  for (const op of ops) {
    const call = decodeInvocation(op, registries);
    if (!call || call.docId !== docId) continue;
    const signed = call.signer
      ? { signer: call.signer, signerFrom: "call" as const }
      : {
          signer: ownerAuthorizer(op, call.fn, docId, registries) ?? (fixedOwner ? owner : null),
          signerFrom: "owner" as const,
        };

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

/** Each operation with its transaction, whose auth entries name an owner-only write's signer. */
const JOIN = "join=transactions";

type HorizonPage = {
  _embedded?: { records?: HorizonOperation[] };
  _links?: { next?: { href?: string } };
};

async function fetchOwnerOperations(owner: string): Promise<HorizonOperation[]> {
  const ops: HorizonOperation[] = [];
  let url: string | undefined =
    `${HORIZON_URL}/accounts/${owner}/operations?order=asc&limit=200&${JOIN}`;

  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res: Response = await fetch(url);
    if (!res.ok) throw new Error(`Horizon error (${res.status})`);
    const body = (await res.json()) as HorizonPage;
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

/**
 * The operations of a source that is not the owner's own (the registry's
 * events, a removed member's feed) that are `signerOf(op)`'s own writes of
 * `docId` on `contractId`: a call that names its signer, and names that one.
 * Anyone can call any registry, so everything else such a source holds (an
 * owner-only call, a call on a legacy registry or forwarded to one, someone
 * else's write) is dropped: it would otherwise be credited to the owner.
 */
export function ownWritesOnly(
  ops: readonly HorizonOperation[],
  docId: string,
  signerOf: (op: HorizonOperation) => string | undefined,
  contractId: string = CONTRACT_ID,
): HorizonOperation[] {
  return ops.filter((op) => {
    const call = decodeInvocation(op, contractId);
    const signer = signerOf(op);
    return call != null && call.docId === docId && call.signer != null && call.signer === signer;
  });
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
        const res = await fetch(`${HORIZON_URL}/transactions/${hash}/operations?limit=10&${JOIN}`);
        // Not on this network's Horizon: not a write we can show.
        if (res.status === 404) return [];
        if (!res.ok) throw new Error(`Horizon error (${res.status})`);
        const body = (await res.json()) as HorizonPage;
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
const MAX_EVENT_PAGES = 12;
/** The event window is read in this many slices, newest first. */
const EVENT_SLICES = 4;

/** A registry event with the ledger it closed in. */
export type LedgerEvent = RegistryEvent & { ledger: number };

/** What the event scan needs from an RPC server. */
export type EventSource = {
  getHealth(): Promise<{ oldestLedger: number; latestLedger: number }>;
  getEvents(request: rpc.Api.GetEventsRequest): Promise<{ events: LedgerEvent[]; cursor: string }>;
};

/** The ledger an RPC cursor (`<toid>-<index>`) points into, or NaN. */
function cursorLedger(cursor: string): number {
  try {
    return Number(BigInt(cursor.split("-")[0]) >> BigInt(32));
  } catch {
    return Number.NaN;
  }
}

/**
 * The registry's events in the RPC's window, read newest first: the window
 * is cut into slices, and a slice that does not fit in one page has its
 * newer half read before its older one, so a page budget running out drops
 * the oldest events (the ones about to leave the window anyway) rather than
 * the newest. `complete` is false when the budget ran out first. An event
 * can be read twice where halves meet; callers dedupe by transaction.
 */
export async function scanRegistryEvents(
  server: EventSource,
  filters: rpc.Api.EventFilter[],
  { pageLimit = EVENT_PAGE, maxPages = MAX_EVENT_PAGES, slices = EVENT_SLICES } = {},
): Promise<{ events: LedgerEvent[]; complete: boolean }> {
  const { oldestLedger, latestLedger } = await server.getHealth();
  // The window's oldest ledger moves on as ledgers close; start a little
  // inside it so the first request is not refused as out of range.
  const first = oldestLedger + 10;
  const last = latestLedger + 1;
  const span = Math.max(1, Math.ceil((last - first) / slices));
  const events: LedgerEvent[] = [];
  let pages = 0;
  let complete = true;

  // Ledgers [start, end).
  async function slice(start: number, end: number): Promise<void> {
    if (pages >= maxPages) {
      complete = false;
      return;
    }
    pages++;
    let page = await server.getEvents({ filters, startLedger: start, endLedger: end, limit: pageLimit });
    for (;;) {
      const inSlice = page.events.filter((e) => e.ledger < end);
      events.push(...inSlice);
      // A short page is not taken as the end: an RPC may cap how many
      // ledgers one request scans. A slice ends at an empty page, at an
      // event or a cursor past its end, or at a cursor that stops moving.
      const reached = page.cursor ? cursorLedger(page.cursor) : Number.NaN;
      if (inSlice.length < page.events.length || page.events.length === 0) return;
      if (Number.isNaN(reached) || reached >= end - 1) return;
      if (end - reached > 2) {
        // Re-reads `reached`, which may hold more events than the page did.
        const mid = Math.ceil((reached + end) / 2);
        await slice(mid, end);
        await slice(reached, mid);
        return;
      }
      if (pages >= maxPages) {
        complete = false;
        return;
      }
      const cursor = page.cursor;
      pages++;
      page = await server.getEvents({ filters, cursor, limit: pageLimit });
      if (page.cursor === cursor) {
        events.push(...page.events.filter((e) => e.ledger < end));
        return;
      }
    }
  }

  for (let end = last; end > first; end -= span) await slice(Math.max(first, end - span), end);
  return { events, complete };
}

/**
 * The `*_as` writes of `docId` still inside the RPC's event window (about a
 * week), wherever they were submitted from: this is how an editor's own
 * Freighter writes, which no feed Doqtri reads contains, reach history.
 * Events only say where to look; each transaction is read from Horizon, and
 * only the event's own signer's write in it is kept.
 */
async function fetchEventOperations(docId: string): Promise<{ ops: HorizonOperation[]; complete: boolean }> {
  const filters: rpc.Api.EventFilter[] = [
    {
      type: "contract",
      contractIds: [CONTRACT_ID],
      topics: [[xdr.ScVal.scvSymbol("doqtri").toXDR("base64"), "*", "*"]],
    },
  ];
  const { events, complete } = await scanRegistryEvents(new rpc.Server(RPC_URL), filters);
  const writes = signedWriteTransactions(events, docId);
  const signerOf = new Map(writes.map((w) => [w.txHash, w.signer]));
  const ops = await fetchTransactionOperations(writes.map((w) => w.txHash));
  return { ops: ownWritesOnly(ops, docId, (op) => signerOf.get(op.transaction_hash)), complete };
}

/** Stellar closes a ledger roughly every 5–6 seconds. */
const SECONDS_PER_LEDGER = 5.5;
const MS_PER_LEDGER = SECONDS_PER_LEDGER * 1000;
/** A start ledger this close before the target time is close enough. */
const LEDGER_SLACK_MS = 10 * 60 * 1000;
/** Stepped back by this much when the estimate could not be checked. */
const SAFETY_LEDGERS = 120;

/** When Horizon says `ledger` closed, or null when it does not have it. */
async function ledgerClosedAt(ledger: number): Promise<number | null> {
  const res = await fetch(`${HORIZON_URL}/ledgers/${ledger}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Horizon error (${res.status})`);
  const closed = Date.parse(((await res.json()) as { closed_at?: string }).closed_at ?? "");
  return Number.isNaN(closed) ? null : closed;
}

/**
 * A ledger that closed at, or shortly before, `time`. Horizon cannot look
 * a ledger up by time, so this estimates from the latest ledger and the
 * average close time, then corrects against the estimate's real close time
 * a few times; one it could not check is stepped back to stay before `time`.
 */
export async function ledgerAtOrBefore(time: number): Promise<number> {
  const res = await fetch(`${HORIZON_URL}/ledgers?order=desc&limit=1`);
  if (!res.ok) throw new Error(`Horizon error (${res.status})`);
  const latest = ((await res.json()) as HorizonLedgerPage)._embedded?.records?.[0];
  const latestClosed = Date.parse(latest?.closed_at ?? "");
  if (!latest || Number.isNaN(latestClosed)) throw new Error("Horizon returned no ledger");
  if (latestClosed <= time) return latest.sequence;

  let ledger = latest.sequence - Math.ceil((latestClosed - time) / MS_PER_LEDGER);
  for (let attempt = 0; attempt < 5 && ledger > 1; attempt++) {
    const closed = await ledgerClosedAt(ledger);
    if (closed == null) break;
    const ahead = closed - time;
    if (ahead <= 0 && ahead > -LEDGER_SLACK_MS) return ledger;
    // Late: step back past it. Early: step forward, but less than the gap.
    ledger = ahead > 0 ? ledger - Math.ceil(ahead / MS_PER_LEDGER) - 1 : ledger + Math.floor(-ahead / MS_PER_LEDGER) - 1;
  }
  return Math.max(1, ledger - SAFETY_LEDGERS);
}

type HorizonLedgerPage = { _embedded?: { records?: { sequence: number; closed_at: string }[] } };

/** A removed member's `G…` feed is read forward from their removal, at most this many pages. */
const MAX_SINCE_PAGES = 10;
/**
 * How long after a removal their feed is read. The writes the flag is for
 * land in the gap before remove_editor reaches the chain (seconds, D-16);
 * a day covers a relayer that is slow or down. Later ones are left to the
 * event window, unless the removal reached the chain later than that, or
 * not at all (`removalWindowLapsed`, WP-1.10).
 */
const REMOVAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * True when a removal's day-long window closed before the feed's natural end
 * (the restoration, or now). The registry accepts that member's writes for
 * as long as they stay on its editor list, so a revoke that failed (R-05)
 * leaves writes after the window that only reading on can find.
 */
export function removalWindowLapsed(signer: RemovedSigner, now: number = Date.now()): boolean {
  const from = Date.parse(signer.removedAt);
  if (Number.isNaN(from)) return false;
  const restored = signer.restoredAt ? Date.parse(signer.restoredAt) : Number.NaN;
  return from + REMOVAL_WINDOW_MS < (Number.isNaN(restored) ? now : restored);
}

/**
 * An account's operations from `since` until `until` (or a day after
 * `since`), oldest first: read forward from a ledger just before `since`,
 * so the writes right after a removal come first and cannot be pushed out
 * by later activity. With `readOn`, the day's bound is lifted and the feed
 * is read to `until` or now, for a member whose removal reached the chain
 * late or not yet. `complete` is false when the page budget ran out before
 * the window's end.
 */
export async function fetchAccountOperationsSince(
  account: string,
  since: string,
  until?: string | null,
  { readOn = false }: { readOn?: boolean } = {},
): Promise<{ ops: HorizonOperation[]; complete: boolean }> {
  const from = Date.parse(since);
  if (Number.isNaN(from)) return { ops: [], complete: true };
  const restored = until ? Date.parse(until) : Number.NaN;
  const to = Math.min(readOn ? Infinity : from + REMOVAL_WINDOW_MS, Number.isNaN(restored) ? Infinity : restored);
  // A paging token is a TOID: the ledger in its high 32 bits.
  const cursor = (BigInt(await ledgerAtOrBefore(from)) << BigInt(32)).toString();

  const ops: HorizonOperation[] = [];
  let url: string | undefined =
    `${HORIZON_URL}/accounts/${account}/operations?order=asc&limit=200&cursor=${cursor}&${JOIN}`;
  for (let page = 0; url; page++) {
    if (page >= MAX_SINCE_PAGES) return { ops: inLedgerOrder(ops), complete: false };
    const res: Response = await fetch(url);
    // An account that was never funded has no feed.
    if (res.status === 404) break;
    if (!res.ok) throw new Error(`Horizon error (${res.status})`);
    const body = (await res.json()) as HorizonPage;
    const records = body._embedded?.records ?? [];
    const inWindow = records.filter((op) => Date.parse(op.created_at) < to);
    ops.push(...inWindow.filter((op) => Date.parse(op.created_at) >= from));
    url = records.length > 0 && inWindow.length === records.length ? body._links?.next?.href : undefined;
  }
  return { ops: inLedgerOrder(ops), complete: true };
}

/**
 * A wallet the document's workspace removed, and when; from doqtri's
 * database. `revokedAt` is when doqtri's revocation of it was done, so the
 * chain no longer accepted its signature (null while none is).
 */
export type RemovedSigner = { address: string; removedAt: string; restoredAt?: string | null; revokedAt?: string | null };

export type HistoryOptions = {
  /**
   * Signers whose writes after their removal must not be missed. Their
   * Freighter (`G…`) feeds are read forward from each removal; passkey
   * wallets have no feed and rely on the index and the events.
   */
  removedSigners?: readonly RemovedSigner[];
};

/** Each `G…` removal once. */
function removedAccounts(signers: readonly RemovedSigner[]): RemovedSigner[] {
  const unique = new Map<string, RemovedSigner>();
  for (const signer of signers) {
    if (!StrKey.isValidEd25519PublicKey(signer.address)) continue;
    unique.set(`${signer.address}@${signer.removedAt}`, signer);
  }
  return [...unique.values()];
}

/** Bounds the removed feeds read for one page view. */
export const MAX_REMOVED_FEEDS = 10;

/**
 * A removed member's own writes of `docId` from their feed. When their
 * removal's window has lapsed, `onChain` (the workspace as the registry holds
 * it now; undefined when it could not be read) decides: a member the chain
 * still lists is read on past the window, within the same page budget; one
 * it no longer lists, or one restored since, is read on to when their
 * revocation was done, if that was after the window, or to now (or the
 * restoration) when doqtri has no record of it being done (it reached the
 * chain some other way, or its job gave up), since the list cannot say when
 * they left it. When the
 * chain could not be read the result is marked incomplete, so the page says
 * history may be partial.
 */
async function removedSignerWrites(
  signer: RemovedSigner,
  docId: string,
  onChain: () => Promise<ChainWorkspace | null | undefined>,
  now: number,
): Promise<{ ops: HorizonOperation[]; complete: boolean }> {
  let readOn = false;
  let until = signer.restoredAt ?? null;
  let unknown = false;
  // Off the chain by when doqtri's revocation was done: within the day, the
  // day's cut stands; later, the feed is read on to then; with no record of
  // it, to the feed's natural end.
  const byRevocation = () => {
    const revokedAt = signer.revokedAt ?? null;
    const revoked = revokedAt ? Date.parse(revokedAt) : Number.NaN;
    if (Number.isNaN(revoked)) readOn = true;
    else if (revoked > Date.parse(signer.removedAt) + REMOVAL_WINDOW_MS) {
      readOn = true;
      until = revokedAt;
    }
  };
  if (removalWindowLapsed(signer, now)) {
    if (signer.restoredAt) {
      // Listed again now, rightly, so the list cannot say whether the
      // removal ever reached the chain; the revocation's record can.
      byRevocation();
    } else {
      const workspace = await onChain();
      if (workspace === undefined) unknown = true;
      else if (workspace != null && chainRoleOf(workspace, signer.address) != null) readOn = true;
      else byRevocation();
    }
  }
  const { ops, complete } = await fetchAccountOperationsSince(signer.address, signer.removedAt, until, { readOn });
  return { ops: ownWritesOnly(ops, docId, () => signer.address), complete: complete && !unknown };
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
  const owner = doc.owner;
  const passkeyOwner = StrKey.isValidContract(owner);
  // Without workspaces nothing moves a document to another owner.
  const build = (ops: HorizonOperation[]) =>
    buildHistory(ops, docId, REGISTRIES, owner, { fixedOwner: !REGISTRY_EDITORS });
  // Only the v3 registry has workspaces; the live one has no get_doc_workspace.
  const workspace = REGISTRY_EDITORS ? await DoqtriRegistry.readDocWorkspace(docId).catch(() => null) : null;
  if (!workspace) {
    if (passkeyOwner) {
      const ops = await fetchIndexedOperations(docId);
      return withCompleteness(build(ops), doc.version);
    }
    const ops = await fetchOwnerOperations(owner);
    return build(ops);
  }
  // A workspace note: its owner's feed (a passkey owner has none), the
  // index, and then the events and removed members' feeds, which only add
  // their signers' own writes; when those are unreachable history is what
  // the first two hold, and the version count says if that is short.
  const unreachable = { ops: [] as HorizonOperation[], complete: false };
  const removedFeeds = removedAccounts(options.removedSigners ?? []).filter((r) => r.address !== owner);
  // Read once, and only when a removal's window has lapsed.
  let chainWorkspace: Promise<ChainWorkspace | null | undefined> | undefined;
  const onChain = () => (chainWorkspace ??= DoqtriRegistry.readWorkspace(workspace).catch(() => undefined));
  const now = Date.now();
  const [ownerOps, indexed, evented, ...removed] = await Promise.all([
    passkeyOwner ? [] : fetchOwnerOperations(owner),
    fetchIndexedOperations(docId),
    fetchEventOperations(docId).catch(() => unreachable),
    ...removedFeeds
      .slice(0, MAX_REMOVED_FEEDS)
      .map((r) => removedSignerWrites(r, docId, onChain, now).catch(() => unreachable)),
  ]);
  const ops = mergeOperations(ownerOps, indexed, evented.ops, ...removed.map((r) => r.ops));
  const partial =
    !evented.complete || removed.some((r) => !r.complete) || removedFeeds.length > MAX_REMOVED_FEEDS;
  return {
    ...withCompleteness(build(ops), doc.version),
    workspace,
    ...(partial ? { partial: true as const } : {}),
  };
}

export type DocumentTtl = {
  liveUntilLedger: number;
  latestLedger: number;
  /** Approximate, from an average ledger close time. */
  expiresAt: Date;
};

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
