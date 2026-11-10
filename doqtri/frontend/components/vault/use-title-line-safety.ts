"use client";

import { useEffect, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { readTitleLineSafety, type SafetyReads, type TitleLineSafety } from "@/lib/title-line-safety";

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
 * Whether the open note may be given its title line (lib/title-line-safety.ts).
 * Read once, from the first render where it is `needed`: a note that opens
 * with its title line never asks. "loading" until the answer is in, which
 * writes nothing. The workspace is remounted per note, so `docId` is fixed.
 */
export function useTitleLineSafety(docId: string, needed: boolean): TitleLineSafety {
  const [safety, setSafety] = useState<TitleLineSafety>("loading");
  const started = useRef(false);
  useEffect(() => {
    if (!needed || started.current) return;
    started.current = true;
    void readTitleLineSafety(docId, browserReads).then(setSafety);
  }, [docId, needed]);
  return safety;
}
