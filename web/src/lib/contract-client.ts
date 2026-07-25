/**
 * Typed DoqtriRegistry client — WASM-generated bindings + Freighter signing.
 */
import type { NodeStatus } from "@/data/demo-map";
import {
  Client,
  Errors,
  type ContractNodeStatus,
  Buffer,
} from "@/lib/bindings/doqtri-registry";
import { CONTRACT_ID, NETWORK_PASSPHRASE, RPC_URL } from "@/lib/config";
import { hexToBytes32 } from "@/lib/hash";
import { signSorobanTx } from "@/lib/wallet";
import { assertFunded } from "@/lib/horizon";
import { DoqtriError, mapWalletError } from "@/lib/errors";

export type ChainDocument = {
  version: number;
  nodeCount: number;
  contentHash: string;
  updatedAt: number;
  owner?: string;
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

function unwrapResult<T>(result: unknown, fallbackMsg: string): T {
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
      const msg = err?.message ?? fallbackMsg;
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

function mapInvokeError(e: unknown): never {
  throw mapWalletError(e);
}

export const DoqtriRegistry = {
  async getDocument(docId: string): Promise<ChainDocument | null> {
    try {
      const tx = await readClient().get_document({ doc_id: docId });
      const doc = unwrapResult<{
        version: number;
        node_count: number;
        content_hash: Buffer;
        updated_at: bigint | number;
        owner: string;
      }>(tx.result, "get_document failed");
      return {
        version: Number(doc.version),
        nodeCount: Number(doc.node_count),
        contentHash: hashToHex(doc.content_hash),
        updatedAt: Number(doc.updated_at),
        owner: doc.owner ? String(doc.owner) : undefined,
      };
    } catch {
      return null;
    }
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
      }>(tx.result, "get_node failed");
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
  ): Promise<string> {
    await assertFunded(source);
    try {
      const tx = await writeClient(source).register_document({
        owner: source,
        doc_id: docId,
        content_hash: hexToBuffer(contentHashHex),
      });
      // Detect already-exists from simulation before prompting Freighter
      try {
        unwrapResult(tx.result, "register failed");
      } catch (e) {
        if (e instanceof DoqtriError && e.code === "ALREADY_EXISTS") {
          return DoqtriRegistry.updateDocument(source, docId, contentHashHex);
        }
        throw e;
      }
      const sent = await tx.signAndSend();
      const hash = sent.sendTransactionResponse?.hash;
      if (!hash) throw new DoqtriError("SEND_FAILED", "No transaction hash");
      return hash;
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
  ): Promise<string> {
    await assertFunded(source);
    try {
      const tx = await writeClient(source).update_document({
        doc_id: docId,
        new_hash: hexToBuffer(contentHashHex),
      });
      const sent = await tx.signAndSend();
      const hash = sent.sendTransactionResponse?.hash;
      if (!hash) throw new DoqtriError("SEND_FAILED", "No transaction hash");
      return hash;
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
  ): Promise<string> {
    await assertFunded(source);
    try {
      const tx = await writeClient(source).set_node_status({
        doc_id: docId,
        node_id: nodeId,
        status: toStatusTag(status),
        tool,
        artifact_ref: artifactRef,
      });
      const sent = await tx.signAndSend();
      const hash = sent.sendTransactionResponse?.hash;
      if (!hash) throw new DoqtriError("SEND_FAILED", "No transaction hash");
      return hash;
    } catch (e) {
      mapInvokeError(e);
    }
  },
};
