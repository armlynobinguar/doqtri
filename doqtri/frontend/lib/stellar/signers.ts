/**
 * Who signed each entry of a note's on-chain history, and whether they still
 * could (WP-1.8).
 *
 * Removing a member is immediate in doqtri's database (D-16), but the chain
 * only stops accepting their signature once the revoke key's remove_editor
 * lands, and a member writing from Freighter submits their own transactions,
 * so a removed member can get a write in during that gap (risk R-05). The
 * ledger has each entry's close time and its signer; doqtri's database has
 * when each signer was removed (workspace_member_removals). Putting the two
 * together flags such writes on the public audit page.
 *
 * The public page shows addresses only. Member names are private to the
 * workspace and no setting publishes them, so none are looked up here.
 */

/** One removal of a wallet from a note's workspace, as the database logged it. */
export type SignerRemoval = {
  address: string;
  removedAt: string;
  /** When they could sign there again, or null while they cannot. */
  restoredAt: string | null;
};

/**
 * The removal in effect for `signer` when an entry closed at `closedAt`, or
 * null when they could sign then. A removal counts when it happened strictly
 * before the ledger closed and was not lifted by then; a ledger that closed
 * in the same instant as the removal (close times have whole seconds) may
 * hold a transaction submitted before it, so it is not flagged. Of several
 * removals in effect, the most recent is returned.
 */
export function removalInEffect(
  signer: string,
  closedAt: string,
  removals: readonly SignerRemoval[],
): SignerRemoval | null {
  const at = Date.parse(closedAt);
  if (Number.isNaN(at)) return null;
  let found: SignerRemoval | null = null;
  for (const removal of removals) {
    if (removal.address !== signer) continue;
    const removed = Date.parse(removal.removedAt);
    if (Number.isNaN(removed) || removed >= at) continue;
    const restored = removal.restoredAt ? Date.parse(removal.restoredAt) : NaN;
    if (!Number.isNaN(restored) && restored <= at) continue;
    if (!found || removed > Date.parse(found.removedAt)) found = removal;
  }
  return found;
}

/** `GABC…WXYZ`: enough to tell wallets apart at a glance. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** Rows as signer_removals_for_document() returns them, with anything malformed dropped. */
export function parseSignerRemovals(rows: unknown): SignerRemoval[] {
  if (!Array.isArray(rows)) return [];
  const removals: SignerRemoval[] = [];
  for (const row of rows) {
    const { address, removed_at, restored_at } = (row ?? {}) as Record<string, unknown>;
    if (typeof address !== "string" || typeof removed_at !== "string") continue;
    removals.push({
      address,
      removedAt: removed_at,
      restoredAt: typeof restored_at === "string" ? restored_at : null,
    });
  }
  return removals;
}
