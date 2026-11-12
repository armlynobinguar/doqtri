/**
 * Which notes already have a record on the ledger.
 *
 * The explorer needs the answer for every note at once, and `get_document` is
 * one simulation per id. The existence of the persistent entry is the whole
 * answer, and `getLedgerEntries` accepts many keys per request, so the whole
 * vault costs a single RPC round trip.
 *
 * An entry the network has already archived is not returned, so a long-dormant
 * anchor reads as "not anchored" here. That is why the delete route re-checks
 * with the contract instead of trusting this.
 */
import { Address, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { CONTRACT_ID, RPC_URL } from "@/lib/stellar/config";

/**
 * The contract's `DataKey::Doc(doc_id)`. A `#[contracttype]` enum variant
 * encodes as `Vec[Symbol(variant), ...fields]`.
 */
export function docLedgerKey(
  docId: string,
  contractId: string = CONTRACT_ID,
): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("Doc"),
        xdr.ScVal.scvString(docId),
      ]),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/**
 * Entries come back without the ids that produced them, and missing ones are
 * simply absent, so the doc id is read back out of each returned key rather
 * than matched by position.
 */
function docIdFromKey(key: xdr.LedgerKey): string | null {
  try {
    const parts = scValToNative(key.contractData().key());
    if (Array.isArray(parts) && parts[0] === "Doc" && typeof parts[1] === "string") {
      return parts[1];
    }
    return null;
  } catch {
    return null;
  }
}

/** Keys per request. Large vaults should not send one enormous RPC body. */
const CHUNK = 50;

/** The subset of `docIds` that is anchored. Throws if the RPC is unreachable. */
export async function anchoredDocIds(docIds: string[]): Promise<Set<string>> {
  const anchored = new Set<string>();
  if (docIds.length === 0) return anchored;

  const server = new rpc.Server(RPC_URL);
  for (let i = 0; i < docIds.length; i += CHUNK) {
    const keys = docIds.slice(i, i + CHUNK).map((id) => docLedgerKey(id));
    const { entries } = await server.getLedgerEntries(...keys);
    for (const entry of entries) {
      const id = docIdFromKey(entry.key);
      if (id !== null) anchored.add(id);
    }
  }
  return anchored;
}

/**
 * The explorer reads the ledger once per change to the note list, and
 * anchoring an existing note does not change that list. So every write that
 * anchors a document's text (register, update, anchor) says so here, and the vault shell moves the note
 * into "On-chain" without a reload.
 *
 * `pending` is a write the relay took but no ledger has yet (DOQ-5): the
 * listener re-reads the ledger for it rather than trusting it landed.
 */
const ANCHORED_EVENT = "doqtri:anchored";

export type AnchoredDetail = { docId: string; pending: boolean };

export function announceAnchored(docId: string, pending: boolean): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AnchoredDetail>(ANCHORED_EVENT, { detail: { docId, pending } }),
  );
}

export function onAnchored(listener: (detail: AnchoredDetail) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<AnchoredDetail>).detail);
  window.addEventListener(ANCHORED_EVENT, handle);
  return () => window.removeEventListener(ANCHORED_EVENT, handle);
}
