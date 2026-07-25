import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { CONTRACT_ID, RPC_URL } from "@/lib/config";
import { DoqtriRegistry } from "@/lib/contract-client";

const INDEX_KEY = "doqtri.chainDocs.v1";

/** Contract topics: (doqtri, register|update|node) — value is always doc_id. */
const DOC_EVENT_TOPICS = new Set(["register", "update", "node"]);

function readIndex(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(INDEX_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function rememberDocId(docId: string) {
  if (typeof window === "undefined") return;
  const set = new Set(readIndex());
  set.add(docId);
  window.localStorage.setItem(INDEX_KEY, JSON.stringify([...set]));
}

function extractDocId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0 && value.length < 128) {
    return value;
  }
  return null;
}

function topicAction(topics: unknown[]): string | null {
  // Expected: ["doqtri", "register" | "update" | "node", ...]
  const parts = topics.map((t) => String(t ?? "").toLowerCase());
  if (!parts.includes("doqtri")) return null;
  for (const p of parts) {
    if (DOC_EVENT_TOPICS.has(p)) return p;
  }
  return null;
}

/** Discover registered doc IDs from recent contract events + local index. */
export async function discoverDocIds(): Promise<string[]> {
  const found = new Set(readIndex());
  try {
    const server = new rpc.Server(RPC_URL);
    const latest = await server.getLatestLedger();
    const startLedger = Math.max(1, latest.sequence - 50_000);
    const page = await server.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [CONTRACT_ID],
        },
      ],
      limit: 200,
    });

    for (const ev of page.events ?? []) {
      try {
        const topics = (ev.topic ?? []).map((t) => {
          try {
            return scValToNative(t as xdr.ScVal);
          } catch {
            return null;
          }
        });
        if (!topicAction(topics)) continue;
        const value = scValToNative(ev.value as xdr.ScVal);
        const id = extractDocId(value);
        if (id) found.add(id);
      } catch {
        // ignore malformed events
      }
    }
  } catch {
    // RPC event scan optional — local index still works
  }
  return [...found];
}

export async function syncVaultFromChain(owner: string) {
  const ids = await discoverDocIds();
  const owned: {
    id: string;
    version: number;
    nodeCount: number;
    contentHash: string;
  }[] = [];

  for (const id of ids) {
    const doc = await DoqtriRegistry.getDocument(id);
    if (!doc) continue;
    // Prefer owner match; if decode omitted owner, keep docs we registered locally
    if (doc.owner && doc.owner !== owner) continue;
    if (!doc.owner && !readIndex().includes(id)) continue;
    owned.push({
      id,
      version: doc.version,
      nodeCount: doc.nodeCount,
      contentHash: doc.contentHash,
    });
    rememberDocId(id);
  }
  return owned;
}
