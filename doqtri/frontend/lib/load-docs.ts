import type { SupabaseClient } from "@supabase/supabase-js";
import { isMindmapStale } from "@/lib/mindmap-hash";
import { parseDocMindmap } from "@/lib/mindmap-types";
import type { Doc } from "@/lib/types";

/**
 * Loads the caller's whole vault as `Doc`s, with stored mindmaps parsed and
 * staleness already decided.
 *
 * Server-only: hashing uses `node:crypto`. Shared by the three pages that need
 * mindmaps so none of them can forget to validate the jsonb or to compare the
 * hash — a page that skipped the comparison would silently show a map of text
 * the note no longer contains.
 *
 * Pass a session-bound client: RLS is what scopes this to the caller.
 */
export async function loadVaultDocs(supabase: SupabaseClient): Promise<Doc[]> {
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, markdown, mindmap, mindmap_hash")
    .order("title", { ascending: true });

  if (error) throw new Error(`Failed to load vault: ${error.message}`);

  return (data ?? []).map((row) => {
    const mindmap = parseDocMindmap(row.mindmap);
    return {
      id: row.id,
      title: row.title,
      markdown: row.markdown,
      mindmap,
      // A note with no map is not "stale" — it has nothing to be stale against.
      mindmapStale: mindmap !== null && isMindmapStale(row.markdown, row.mindmap_hash),
    };
  });
}
