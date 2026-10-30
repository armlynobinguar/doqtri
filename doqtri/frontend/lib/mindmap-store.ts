import type { SupabaseClient } from "@supabase/supabase-js";
import { extractMindmap } from "@/lib/mindmap-ai";
import { hashMarkdown } from "@/lib/mindmap-hash";
import type { DocMindmap } from "@/lib/mindmap-types";

/**
 * Generate a document's mindmap and write it to its row.
 *
 * Shared by ingest, regenerate, and the explicit rebuild route so the three
 * cannot drift on how the map and its hash are paired — a stored mindmap whose
 * hash came from different markdown would report itself fresh forever.
 *
 * `workspaceId` is required and applied to the write even though `id` is
 * unique: this runs with the service role, so callers must have checked the
 * user's role in that workspace, and the write cannot reach another one.
 */
export async function generateAndStoreMindmap(
  admin: SupabaseClient,
  params: {
    id: string;
    workspaceId: string;
    title: string;
    markdown: string;
    signal?: AbortSignal;
  },
): Promise<DocMindmap> {
  const { id, workspaceId, title, markdown, signal } = params;

  const mindmap = await extractMindmap({ title, markdown, signal });

  const { error } = await admin
    .from("documents")
    .update({ mindmap, mindmap_hash: hashMarkdown(markdown) })
    .eq("id", id)
    .eq("workspace_id", workspaceId);

  if (error) throw new Error(error.message);

  return mindmap;
}
