/**
 * Typed DoqtriRegistry client — WASM-generated bindings.
 *
 * Two kinds of signer, told apart by the source address:
 * - `G…` (Freighter and other wallets): the account is the transaction source,
 *   signs the envelope, and pays the fee, so funding is checked first.
 * - `C…` (an email account's passkey smart wallet): the wallet only signs the
 *   call's auth entry; /api/chain/relay submits it. Where users pay their own
 *   fees (progress/003) the call is wrapped in the FeeForwarder and the wallet
 *   pays Doqtri's relayer in XLM; otherwise Channels pays.
 *
 * Two kinds of document, told apart by its workspace (WP-1.4, behind
 * REGISTRY_EDITORS until the deployed registry is upgraded):
 * - personal: the owner-only calls, as before.
 * - team workspace: the `*_as` calls, naming the signer, since the document
 *   is owned on-chain by the workspace's owner (D-28) and written by its
 *   members. A new team document is registered by its first signer and then
 *   handed to the workspace with `assign_document`, a second signature;
 *   every team write checks `get_doc_workspace` and repeats that step if it
 *   never landed (reconcileWorkspace).
 */
import type { NodeStatus } from "@/lib/stellar/types";
import {
  Client,
  Errors,
  MAX_NODES_PER_CALL,
  type ContractNodeStatus,
  Buffer,
} from "@/lib/bindings/doqtri-registry";
import { CONTRACT_ID, NETWORK_PASSPHRASE, REGISTRY_EDITORS, RPC_URL } from "@/lib/stellar/config";
import { hexToBytes32 } from "@/lib/stellar/hash";
import { signSorobanTx } from "@/lib/wallet";
import { passkeyWalletFor, payAndRelay, signAndRelay } from "@/lib/passkey-wallet";
import { USER_PAYS_FEES } from "@/lib/stellar/smart-wallet-config";
import { rpc, scValToNative, StrKey, type contract } from "@stellar/stellar-sdk";
import { assertBalanceCovers, getAccountBalance, type AccountBalance } from "@/lib/stellar/horizon";
import { DoqtriError, mapWalletError, workspaceContractError } from "@/lib/stellar/errors";

export type ChainDocument = {
  version: number;
  nodeCount: number;
  contentHash: string;
  updatedAt: number;
  owner?: string;
};

/**
 * Where a team document stands after a write: in its workspace on-chain, so
 * every editor can write it, or not yet, with why. `txHash` is set when this
 * write is what assigned it.
 */
export type WorkspaceAssignment =
  | { status: "assigned"; txHash?: string }
  | { status: "unassigned"; reason: string };

/** What a registry write leaves behind for the UI to show as a receipt. */
export type WriteReceipt = {
  txHash: string;
  /** The document version after the write; absent for node-status writes. */
  version?: number;
  /** Set for writes on a team workspace's document (editor mode). */
  workspace?: WorkspaceAssignment;
};

/**
 * The workspace a document belongs to, as doqtri's database has it. Its id
 * is also the workspace's id on-chain.
 */
export type WriteTarget = { workspaceId: string; personal: boolean };

/**
 * Which registry calls a write on a document uses: the `*_as` calls for a
 * team workspace's document once REGISTRY_EDITORS is on, else the owner-only
 * ones. A personal workspace's documents keep the owner-only calls: only
 * their creator writes them, and they are never assigned.
 */
export function writeMode(
  target: WriteTarget | null | undefined,
  enabled: boolean = REGISTRY_EDITORS,
): "owner" | "editor" {
  return enabled && target != null && !target.personal ? "editor" : "owner";
}

export type ChainNode = {
  status: string;
  tool: string;
  artifactRef: string;
  updatedAt: number;
};

function hashToHex(hash: Buffer | Uint8Array | string): string {
  if (typeof hash === "string") return hash;
  const bytes = hash instanceof Buffer ? hash : Buffer.from(hash);
  return bytes.toString("hex");
}

function toStatusTag(status: NodeStatus): ContractNodeStatus {
  return { tag: status, values: undefined as unknown as void };
}

function fromStatusTag(status: ContractNodeStatus | string): string {
  if (typeof status === "string") return status;
  return status?.tag ?? "Unknown";
}

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hexToBytes32(hex));
}

function readClient() {
  return new Client({
    contractId: CONTRACT_ID,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
  });
}

function isSmartWallet(source: string): boolean {
  return StrKey.isValidContract(source);
}

function writeClient(publicKey: string) {
  // A smart wallet cannot be a transaction source; simulate from the SDK's
  // null account and let the relay's Channels account supply the real one.
  if (isSmartWallet(publicKey)) return readClient();
  return new Client({
    contractId: CONTRACT_ID,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey,
    signTransaction: async (xdr, opts) => {
      const signedTxXdr = await signSorobanTx(
        xdr,
        opts?.address ?? publicKey,
      );
      return { signedTxXdr };
    },
  });
}

/** The simulation's error text, which names the contract error code. */
function simulationError(tx: unknown): string | undefined {
  const error = (tx as { simulation?: { error?: unknown } }).simulation?.error;
  return typeof error === "string" ? error : undefined;
}

function unwrapResult<T>(
  result: unknown,
  fallbackMsg: string,
  simulationError?: string,
): T {
  if (
    result &&
    typeof result === "object" &&
    "isErr" in result &&
    typeof (result as { isErr: () => boolean }).isErr === "function"
  ) {
    const r = result as {
      isErr: () => boolean;
      unwrap: () => T;
      unwrapErr: () => { message?: string };
    };
    if (r.isErr()) {
      const err = r.unwrapErr();
      // The generated client leaves the message empty for contract errors;
      // the code only survives in the simulation's HostError text.
      const code = /Error\(Contract, #(\d+)\)/.exec(simulationError ?? "")?.[1];
      const msg =
        err?.message ||
        (code ? Errors[Number(code) as keyof typeof Errors]?.message : undefined) ||
        fallbackMsg;
      const named = Object.entries(Errors).find(([, e]) => e.message === msg)?.[0];
      const workspaceError = workspaceContractError(Number(code ?? named));
      if (workspaceError) throw workspaceError;
      if (msg.includes("DocumentAlreadyExists") || msg === Errors[1].message) {
        throw new DoqtriError("ALREADY_EXISTS", "Document already registered");
      }
      if (msg.includes("DocumentNotFound") || msg === Errors[2].message) {
        throw new DoqtriError("NOT_FOUND", "Document not found on-chain");
      }
      if (msg.includes("NodeNotFound") || msg === Errors[3].message) {
        throw new DoqtriError("NODE_NOT_FOUND", "Node not found on-chain");
      }
      if (msg.includes("NotOwner") || msg === Errors[5].message) {
        throw new DoqtriError("NOT_OWNER", "This note is anchored by a different wallet.");
      }
      if (msg.includes("TooManyNodes") || msg === Errors[4].message) {
        throw new DoqtriError("TOO_MANY_NODES", "Too many nodes to anchor at once.");
      }
      throw new DoqtriError("CONTRACT", msg);
    }
    return r.unwrap();
  }
  return result as T;
}

/**
 * Builds (simulates) a write while reading the signer's balance from Horizon,
 * instead of one after the other. A `G…` account that doesn't exist fails with
 * the funding message rather than a confusing simulation error. Smart wallets
 * pay through the relay, so there is nothing to read.
 */
async function buildChecked<T>(
  source: string,
  build: () => Promise<contract.AssembledTransaction<T>>,
): Promise<{ tx: contract.AssembledTransaction<T>; balance: AccountBalance | null }> {
  if (isSmartWallet(source)) return { tx: await build(), balance: null };
  const [balance, tx] = await Promise.allSettled([getAccountBalance(source), build()]);
  if (balance.status === "fulfilled") assertBalanceCovers(balance.value, 0);
  if (tx.status === "rejected") throw tx.reason;
  // Horizon unreachable: carry on; the network still refuses an unfunded write.
  return { tx: tx.value, balance: balance.status === "fulfilled" ? balance.value : null };
}

/**
 * The pre-flight funding check: after simulation, when the real fee is known,
 * and before the wallet is asked to sign anything, against the balance read
 * while building.
 */
function preflight(balance: AccountBalance | null, tx: { built?: { fee: string } }): void {
  if (balance) assertBalanceCovers(balance, Number(tx.built?.fee ?? 0));
}

/** The document version a confirmed register/update returned, if it can be read. */
function versionOf(result: rpc.Api.GetSuccessfulTransactionResponse): number | undefined {
  if (!result.returnValue) return undefined;
  const value = scValToNative(result.returnValue) as unknown;
  const version = Number((value as { ok?: unknown })?.ok ?? value);
  return Number.isFinite(version) ? version : undefined;
}

/** How many one-second checks to wait for a ledger (~5s each) to include a write. */
const CONFIRM_ATTEMPTS = 30;

/**
 * A `G…` signer: the wallet signs, then the write is sent and checked once a
 * second until a ledger includes it. The SDK's own signAndSend backs off
 * (1s, 1.5s, 2.25s, 3.4s, 5s…), so a write that landed in a ~5s ledger often
 * sat unnoticed for several more seconds.
 */
async function signSendAndConfirm<T>(tx: contract.AssembledTransaction<T>, hasVersion: boolean): Promise<WriteReceipt> {
  await tx.sign();
  if (!tx.signed) throw new DoqtriError("SEND_FAILED", "The transaction was not signed");
  const server = new rpc.Server(RPC_URL);
  const sent = await server.sendTransaction(tx.signed);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    // Same wording the SDK used, so mapWalletError still recognises funding errors.
    throw new Error(`Sending the transaction to the network failed! ${JSON.stringify(sent)}`);
  }
  const result = await server.pollTransaction(sent.hash, { attempts: CONFIRM_ATTEMPTS });
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new DoqtriError(
      "SEND_FAILED",
      result.status === rpc.Api.GetTransactionStatus.NOT_FOUND
        ? "The network hasn't confirmed this write yet. Check again in a minute before retrying."
        : "The transaction failed on-chain.",
    );
  }
  if (!hasVersion) return { txHash: sent.hash };
  return { txHash: sent.hash, version: versionOf(result) };
}

/** Signs and submits with whichever signer `source` is; returns the receipt. */
async function send<T>(
  source: string,
  tx: contract.AssembledTransaction<T>,
  hasVersion: boolean,
): Promise<WriteReceipt> {
  if (!isSmartWallet(source)) return signSendAndConfirm(tx, hasVersion);

  const wallet = passkeyWalletFor(source);
  const txHash = USER_PAYS_FEES ? (await payAndRelay(tx, wallet)).hash : await signAndRelay(tx, wallet);
  if (!hasVersion) return { txHash };
  // The relay waited for the ledger, so the result is final; read the version
  // it returned instead of re-querying the document.
  try {
    const result = await new rpc.Server(RPC_URL).getTransaction(txHash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return { txHash, version: versionOf(result) };
  } catch {
    // The write landed; only the version label is missing.
  }
  return { txHash };
}

function mapInvokeError(e: unknown): never {
  throw mapWalletError(e);
}

/** A team write's receipt, with where the document stands in its workspace. */
async function withWorkspace(
  source: string,
  docId: string,
  target: WriteTarget,
  receipt: WriteReceipt,
): Promise<WriteReceipt> {
  return { ...receipt, workspace: await DoqtriRegistry.reconcileWorkspace(source, docId, target) };
}

export const DoqtriRegistry = {
  /** Best-effort read: null for "not anchored" and for any network failure. */
  async getDocument(docId: string): Promise<ChainDocument | null> {
    try {
      return await DoqtriRegistry.readDocument(docId);
    } catch {
      return null;
    }
  },

  /**
   * Strict read: null only when the contract says the document does not exist.
   * Transport and RPC failures throw, so a public page can tell "not anchored"
   * apart from "the ledger could not be reached".
   */
  async readDocument(docId: string): Promise<ChainDocument | null> {
    const tx = await readClient().get_document({ doc_id: docId });
    let doc: {
      version: number;
      node_count: number;
      content_hash: Buffer;
      updated_at: bigint | number;
      owner: string;
    };
    try {
      doc = unwrapResult(tx.result, "get_document failed", simulationError(tx));
    } catch (e) {
      if (e instanceof DoqtriError && e.code === "NOT_FOUND") return null;
      throw e;
    }
    return {
      version: Number(doc.version),
      nodeCount: Number(doc.node_count),
      contentHash: hashToHex(doc.content_hash),
      updatedAt: Number(doc.updated_at),
      owner: doc.owner ? String(doc.owner) : undefined,
    };
  },

  async getNode(docId: string, nodeId: string): Promise<ChainNode | null> {
    try {
      const tx = await readClient().get_node({
        doc_id: docId,
        node_id: nodeId,
      });
      const node = unwrapResult<{
        status: ContractNodeStatus;
        tool: string;
        artifact_ref: string;
        updated_at: bigint | number;
      }>(tx.result, "get_node failed", simulationError(tx));
      return {
        status: fromStatusTag(node.status),
        tool: String(node.tool ?? ""),
        artifactRef: String(node.artifact_ref ?? ""),
        updatedAt: Number(node.updated_at),
      };
    } catch {
      return null;
    }
  },

  /** A workspace's current owner on-chain, or null when there is no such workspace. Throws on transport errors. */
  async readWorkspaceOwner(workspaceId: string): Promise<string | null> {
    const tx = await readClient().get_workspace({ workspace_id: workspaceId });
    try {
      return String(unwrapResult<{ owner: string }>(tx.result, "get_workspace failed", simulationError(tx)).owner);
    } catch (e) {
      if (e instanceof DoqtriError && e.code === "WORKSPACE_NOT_FOUND") return null;
      throw e;
    }
  },

  /** The workspace a document is assigned to on-chain, or null. Throws on transport errors. */
  async readDocWorkspace(docId: string): Promise<string | null> {
    const tx = await readClient().get_doc_workspace({ doc_id: docId });
    return tx.result ?? null;
  },

  async registerDocument(
    source: string,
    docId: string,
    contentHashHex: string,
    target?: WriteTarget | null,
  ): Promise<WriteReceipt> {
    // There is no register_document_as: anchor_as registers a new document
    // with its signer as the owner, and assign_document then hands it on.
    if (writeMode(target) === "editor") return DoqtriRegistry.anchor(source, docId, contentHashHex, [], target);
    try {
      const { tx, balance } = await buildChecked(source, () =>
        writeClient(source).register_document({
          owner: source,
          doc_id: docId,
          content_hash: hexToBuffer(contentHashHex),
        }),
      );
      // Detect already-exists from simulation before prompting the signer
      try {
        unwrapResult(tx.result, "register failed", simulationError(tx));
      } catch (e) {
        if (e instanceof DoqtriError && e.code === "ALREADY_EXISTS") {
          return DoqtriRegistry.updateDocument(source, docId, contentHashHex);
        }
        throw e;
      }
      preflight(balance, tx);
      return await send(source, tx, true);
    } catch (e) {
      if (e instanceof DoqtriError && e.code === "ALREADY_EXISTS") {
        return DoqtriRegistry.updateDocument(source, docId, contentHashHex);
      }
      const mapped = mapWalletError(e);
      if (mapped.code === "ALREADY_EXISTS") {
        return DoqtriRegistry.updateDocument(source, docId, contentHashHex);
      }
      throw mapped;
    }
  },

  async updateDocument(
    source: string,
    docId: string,
    contentHashHex: string,
    target?: WriteTarget | null,
  ): Promise<WriteReceipt> {
    const editor = writeMode(target) === "editor";
    let receipt: WriteReceipt;
    try {
      const { tx, balance } = await buildChecked(source, () =>
        editor
          ? writeClient(source).update_document_as({
              signer: source,
              doc_id: docId,
              new_hash: hexToBuffer(contentHashHex),
            })
          : writeClient(source).update_document({
              doc_id: docId,
              new_hash: hexToBuffer(contentHashHex),
            }),
      );
      if (editor) unwrapResult(tx.result, "update failed", simulationError(tx));
      preflight(balance, tx);
      receipt = await send(source, tx, true);
    } catch (e) {
      mapInvokeError(e);
    }
    return editor ? withWorkspace(source, docId, target!, receipt) : receipt;
  },

  /**
   * One transaction, one signature: registers the document if it is new,
   * anchors `contentHashHex` as a new version if it changed (the same text
   * keeps its version), and writes every node status in `nodes`. On a team
   * document it is `anchor_as`, followed, for a new document, by the
   * `assign_document` that puts it in its workspace.
   */
  async anchor(
    source: string,
    docId: string,
    contentHashHex: string,
    nodes: { nodeId: string; status: NodeStatus; tool: string; artifactRef: string }[],
    target?: WriteTarget | null,
  ): Promise<WriteReceipt> {
    if (nodes.length > MAX_NODES_PER_CALL) {
      throw new DoqtriError("TOO_MANY_NODES", `At most ${MAX_NODES_PER_CALL} nodes can be anchored at once.`);
    }
    const editor = writeMode(target) === "editor";
    const updates = nodes.map((n) => ({
      node_id: n.nodeId,
      status: toStatusTag(n.status),
      tool: n.tool,
      artifact_ref: n.artifactRef,
    }));
    const contentHash = hexToBuffer(contentHashHex);
    let receipt: WriteReceipt;
    try {
      const { tx, balance } = await buildChecked(source, () =>
        editor
          ? writeClient(source).anchor_as({ signer: source, doc_id: docId, content_hash: contentHash, nodes: updates })
          : writeClient(source).anchor({ owner: source, doc_id: docId, content_hash: contentHash, nodes: updates }),
      );
      unwrapResult(tx.result, "anchor failed", simulationError(tx));
      preflight(balance, tx);
      receipt = await send(source, tx, true);
    } catch (e) {
      mapInvokeError(e);
    }
    return editor ? withWorkspace(source, docId, target!, receipt) : receipt;
  },

  async setNodeStatus(
    source: string,
    docId: string,
    nodeId: string,
    status: NodeStatus,
    tool: string,
    artifactRef: string,
    target?: WriteTarget | null,
  ): Promise<WriteReceipt> {
    const editor = writeMode(target) === "editor";
    let receipt: WriteReceipt;
    try {
      const { tx, balance } = await buildChecked(source, () =>
        editor
          ? writeClient(source).set_node_status_as({
              signer: source,
              doc_id: docId,
              node_id: nodeId,
              status: toStatusTag(status),
              tool,
              artifact_ref: artifactRef,
            })
          : writeClient(source).set_node_status({
              doc_id: docId,
              node_id: nodeId,
              status: toStatusTag(status),
              tool,
              artifact_ref: artifactRef,
            }),
      );
      if (editor) unwrapResult(tx.result, "set_node_status failed", simulationError(tx));
      preflight(balance, tx);
      receipt = await send(source, tx, false);
    } catch (e) {
      mapInvokeError(e);
    }
    return editor ? withWorkspace(source, docId, target!, receipt) : receipt;
  },

  /**
   * Puts a document in a workspace on-chain, so its members may write it.
   * The document's current on-chain owner signs (for a new document, the
   * wallet that registered it). Only with REGISTRY_EDITORS.
   */
  async assignDocument(source: string, docId: string, workspaceId: string): Promise<WriteReceipt> {
    if (!REGISTRY_EDITORS) {
      throw new DoqtriError("NOT_ENABLED", "Workspace calls aren't enabled on this registry yet.");
    }
    try {
      const { tx, balance } = await buildChecked(source, () =>
        writeClient(source).assign_document({ doc_id: docId, workspace_id: workspaceId }),
      );
      unwrapResult(tx.result, "assign_document failed", simulationError(tx));
      preflight(balance, tx);
      return await send(source, tx, false);
    } catch (e) {
      mapInvokeError(e);
    }
  },

  /**
   * Makes `admin` an admin of `workspaceId` on-chain. Only the workspace's
   * owner (`source`) can sign it. After a transfer the former owner holds no
   * role on-chain, and when the database kept them as an admin this is the
   * follow-up that makes the chain agree (D-35; formerOwnerFollowUp() in
   * ownership-transfer.ts says when). Only with REGISTRY_EDITORS.
   */
  async addAdmin(source: string, workspaceId: string, admin: string): Promise<WriteReceipt> {
    if (!REGISTRY_EDITORS) {
      throw new DoqtriError("NOT_ENABLED", "Workspace calls aren't enabled on this registry yet.");
    }
    try {
      const { tx, balance } = await buildChecked(source, () =>
        writeClient(source).add_admin({ workspace_id: workspaceId, owner: source, admin }),
      );
      unwrapResult(tx.result, "add_admin failed", simulationError(tx));
      preflight(balance, tx);
      return await send(source, tx, false);
    } catch (e) {
      mapInvokeError(e);
    }
  },

  /**
   * The second step of creating a team document, and its repair: when the
   * chain does not have the document in `target`'s workspace, and `source`
   * is the document's on-chain owner, assigns it there and reads
   * `get_doc_workspace` back to confirm. Never throws: the write before it
   * already landed, so a failure here is reported, not raised.
   */
  async reconcileWorkspace(source: string, docId: string, target: WriteTarget): Promise<WorkspaceAssignment> {
    const current = await DoqtriRegistry.readDocWorkspace(docId).catch(() => undefined);
    if (current === target.workspaceId) return { status: "assigned" };
    if (current === undefined) {
      return { status: "unassigned", reason: "The ledger couldn't be reached to check this note's workspace." };
    }
    // Who assign_document makes sign: for a note in no workspace, its stored
    // owner; for one already in another workspace (moved in the app), that
    // workspace's CURRENT owner, which the stored owner can lag behind after
    // transfer_workspace or admin_reassign_owner.
    const signer = current
      ? await DoqtriRegistry.readWorkspaceOwner(current).catch(() => undefined)
      : (await DoqtriRegistry.getDocument(docId))?.owner;
    if (signer !== source) {
      return {
        status: "unassigned",
        reason: current
          ? "This note is still in its old workspace on-chain; only that workspace's owner can move it."
          : "Only the wallet that owns this note on-chain can put it in the workspace.",
      };
    }
    let assigned: WriteReceipt;
    try {
      assigned = await DoqtriRegistry.assignDocument(source, docId, target.workspaceId);
    } catch (e) {
      return { status: "unassigned", reason: mapWalletError(e).message };
    }
    const after = await DoqtriRegistry.readDocWorkspace(docId).catch(() => undefined);
    return after === target.workspaceId
      ? { status: "assigned", txHash: assigned.txHash }
      : { status: "unassigned", reason: "The ledger doesn't show this note in the workspace yet." };
  },
};
