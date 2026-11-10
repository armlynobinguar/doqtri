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
 * Pass a session-bound client: RLS is what limits this to documents the
 * caller may read. Of those, only `workspaceId`'s are loaded: RLS also lets
 * in every other workspace they belong to, and the vault shows one workspace
 * at a time (WP-1.7). Pass the active workspace (getActiveWorkspace()), so
 * the graph, the mindmaps and [[wikilink]] resolution never reach across
 * workspaces.
 */
export async function loadVaultDocs(supabase: SupabaseClient, workspaceId: string): Promise<Doc[]> {
  const { data, error } = await supabase
    .from("documents")
    .select(VAULT_DOC_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("title", { ascending: true });

  if (error) throw new Error(`Failed to load vault: ${error.message}`);

  return (data ?? []).map(docFromRow);
}

/** The columns docFromRow() reads. */
export const VAULT_DOC_COLUMNS = "id, title, markdown, mindmap, mindmap_hash, version, created_at";

export type VaultDocRow = {
  id: string;
  title: string;
  markdown: string;
  mindmap: unknown;
  mindmap_hash: string | null;
  version: number | string;
  created_at: string;
};

/**
 * One documents row as a `Doc`: the stored mindmap parsed and its staleness
 * decided. Shared with the hackathon snapshot (lib/integrations/qdit-hackathon.ts),
 * so the global mindmap it sends is built from exactly what the vault pages
 * show.
 */
export function docFromRow(row: VaultDocRow): Doc {
  const mindmap = parseDocMindmap(row.mindmap);
  return {
    id: row.id,
    title: row.title,
    markdown: row.markdown,
    version: Number(row.version),
    created_at: row.created_at,
    mindmap,
    // A note with no map is not "stale" — it has nothing to be stale against.
    mindmapStale: mindmap !== null && isMindmapStale(row.markdown, row.mindmap_hash),
  };
}
