/**
 * Typed DoqtriRegistry client — WASM-generated bindings + Freighter signing.
 */
import type { NodeStatus } from "@/lib/stellar/types";
import {
  Client,
  Errors,
  type ContractNodeStatus,
  Buffer,
} from "@/lib/bindings/doqtri-registry";
import { CONTRACT_ID, NETWORK_PASSPHRASE, RPC_URL } from "@/lib/stellar/config";
import { hexToBytes32 } from "@/lib/stellar/hash";
import { signSorobanTx } from "@/lib/wallet";
import { assertCanPay, assertFunded } from "@/lib/stellar/horizon";
import { DoqtriError, mapWalletError } from "@/lib/stellar/errors";

export type ChainDocument = {
  version: number;
  nodeCount: number;
  contentHash: string;
  updatedAt: number;
  owner?: string;
};

/** What a registry write leaves behind for the UI to show as a receipt. */
export type WriteReceipt = {
  txHash: string;
  /** The document version after the write; absent for node-status writes. */
  version?: number;
};

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

function writeClient(publicKey: string) {
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
      if (msg.includes("DocumentAlreadyExists") || msg === Errors[1].message) {
        throw new DoqtriError("ALREADY_EXISTS", "Document already registered");
      }
      if (msg.includes("DocumentNotFound") || msg === Errors[2].message) {
        throw new DoqtriError("NOT_FOUND", "Document not found on-chain");
      }
      if (msg.includes("NodeNotFound") || msg === Errors[3].message) {
        throw new DoqtriError("NODE_NOT_FOUND", "Node not found on-chain");
      }
      throw new DoqtriError("CONTRACT", msg);
    }
    return r.unwrap();
  }
  return result as T;
}

/**
 * register/update return the new version; read it from the confirmed result
 * rather than re-querying, which can race a lagging RPC node.
 */
function receipt(
  sent: { sendTransactionResponse?: { hash?: string }; result: unknown },
  hasVersion: boolean,
): WriteReceipt {
  const txHash = sent.sendTransactionResponse?.hash;
  if (!txHash) throw new DoqtriError("SEND_FAILED", "No transaction hash");
  if (!hasVersion) return { txHash };
  try {
    return { txHash, version: Number(unwrapResult<number>(sent.result, "write failed")) };
  } catch {
    return { txHash };
  }
}

/**
 * The pre-flight funding check: runs after simulation, when the real fee is
 * known, and before the wallet is asked to sign anything.
 */
async function preflight(source: string, tx: { built?: { fee: string } }): Promise<void> {
  await assertCanPay(source, Number(tx.built?.fee ?? 0));
}

function mapInvokeError(e: unknown): never {
  throw mapWalletError(e);
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

  async registerDocument(
    source: string,
    docId: string,
    contentHashHex: string,
  ): Promise<WriteReceipt> {
    await assertFunded(source);
    try {
      const tx = await writeClient(source).register_document({
        owner: source,
        doc_id: docId,
        content_hash: hexToBuffer(contentHashHex),
      });
      // Detect already-exists from simulation before prompting Freighter
      try {
        unwrapResult(tx.result, "register failed", simulationError(tx));
      } catch (e) {
        if (e instanceof DoqtriError && e.code === "ALREADY_EXISTS") {
          return DoqtriRegistry.updateDocument(source, docId, contentHashHex);
        }
        throw e;
      }
      await preflight(source, tx);
      const sent = await tx.signAndSend();
      return receipt(sent, true);
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
  ): Promise<WriteReceipt> {
    await assertFunded(source);
    try {
      const tx = await writeClient(source).update_document({
        doc_id: docId,
        new_hash: hexToBuffer(contentHashHex),
      });
      await preflight(source, tx);
      const sent = await tx.signAndSend();
      return receipt(sent, true);
    } catch (e) {
      mapInvokeError(e);
    }
  },

  async setNodeStatus(
    source: string,
    docId: string,
    nodeId: string,
    status: NodeStatus,
    tool: string,
    artifactRef: string,
  ): Promise<WriteReceipt> {
    await assertFunded(source);
    try {
      const tx = await writeClient(source).set_node_status({
        doc_id: docId,
        node_id: nodeId,
        status: toStatusTag(status),
        tool,
        artifact_ref: artifactRef,
      });
      await preflight(source, tx);
      const sent = await tx.signAndSend();
      return receipt(sent, false);
    } catch (e) {
      mapInvokeError(e);
    }
  },
};
