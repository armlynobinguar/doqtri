/**
 * Whether a note that does not open with its title line may be given one
 * (D-120, lib/title-line.ts). Putting `# <title>` above the text moves every
 * heading down one place, and headings are identified by position (`h0`,
 * `h1`…, lib/mindmap.ts): node links to qdit and GitHub hang off those ids,
 * and so do the note's on-chain node records (DoqtriRegistry.readNode), next
 * to the content hash its anchor proves. So a note with any of those never
 * gets the line; it shows the title above its text instead, display only.
 *
 * The answer is read from what the ship panel and the qdit status read: the
 * note's node_links rows, the chain write index (chain_writes, pending or
 * not), and the ledger's own record of the document. Anything that cannot be
 * read counts as a reason not to: a note is left as it is rather than risk
 * moving what is anchored to it.
 */

export type TitleLineSafety =
  /** Not known yet: nothing is written meanwhile. */
  | "loading"
  /** Nothing hangs off the note's headings: the line may go in. */
  | "allowed"
  /** Linked, registered or anchored, or not readable: the line never goes in. */
  | "blocked";

/** The reads the answer is made of; each resolves true when it finds something. */
export type SafetyReads = {
  /** Any node_links row for the note, qdit or GitHub. */
  hasNodeLinks(docId: string): Promise<boolean>;
  /** Any chain_writes row for the note: a registration or anchor sent, pending or confirmed. */
  hasChainWrites(docId: string): Promise<boolean>;
  /** The ledger has the document: it was registered. Throws when the ledger cannot be read. */
  isRegistered(docId: string): Promise<boolean>;
};

/** "allowed" only when every read succeeded and found nothing; "blocked" otherwise. */
export async function readTitleLineSafety(docId: string, reads: SafetyReads): Promise<Exclude<TitleLineSafety, "loading">> {
  const outcome = await readTitleLineSafetyOutcome(docId, reads);
  return outcome === "allowed" ? "allowed" : "blocked";
}

/**
 * The same answer, telling a read that failed ("unreadable") apart from one
 * that found something ("blocked"), for a caller that may ask again rather
 * than give up on a line for good (DOQ-46). Something found counts even when
 * another read failed.
 */
export async function readTitleLineSafetyOutcome(
  docId: string,
  reads: SafetyReads,
): Promise<"allowed" | "blocked" | "unreadable"> {
  const settled = await Promise.allSettled([
    reads.hasNodeLinks(docId),
    reads.hasChainWrites(docId),
    reads.isRegistered(docId),
  ]);
  if (settled.some((read) => read.status === "fulfilled" && read.value)) return "blocked";
  return settled.some((read) => read.status === "rejected") ? "unreadable" : "allowed";
}
