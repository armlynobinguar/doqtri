import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  readTitleLineSafety,
  readTitleLineSafetyOutcome,
  type SafetyReads,
  type TitleLineSafety,
} from "@/lib/title-line-safety";

/** The reads behind the answer, in the browser: the same tables and ledger the ship panel reads. */
const browserReads: SafetyReads = {
  async hasNodeLinks(docId) {
    const { data, error } = await createSupabaseBrowserClient()
      .from("node_links")
      .select("id")
      .eq("document_id", docId)
      .limit(1);
    if (error) throw new Error(error.message);
    return (data ?? []).length > 0;
  },
  async hasChainWrites(docId) {
    const { hasIndexedWrites } = await import("@/lib/stellar/history");
    return hasIndexedWrites(docId);
  },
  async isRegistered(docId) {
    // Loaded only for a note that needs the answer: the ledger client is large.
    const { DoqtriRegistry } = await import("@/lib/stellar/contract-client");
    return (await DoqtriRegistry.readDocument(docId)) !== null;
  },
};

/**
 * Whether the open note may be given its title line now (lib/title-line-safety.ts),
 * read afresh: the editor asks after a note's first edit, and nothing is kept
 * from one ask to the next, so a link or anchor made since counts.
 */
export function checkTitleLineSafety(docId: string): Promise<Exclude<TitleLineSafety, "loading">> {
  return readTitleLineSafety(docId, browserReads);
}

/** The same, telling a read that failed apart from a real block (DOQ-46): for the rewrite after a rename. */
export function checkTitleLineSafetyOutcome(docId: string): Promise<"allowed" | "blocked" | "unreadable"> {
  return readTitleLineSafetyOutcome(docId, browserReads);
}
