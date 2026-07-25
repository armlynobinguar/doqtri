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
 * `userId` is required and applied to the write even though `id` is unique:
 * this runs with the service role, so ownership is enforced here or nowhere.
 */
export async function generateAndStoreMindmap(
  admin: SupabaseClient,
  params: { id: string; userId: string; title: string; markdown: string },
): Promise<DocMindmap> {
  const { id, userId, title, markdown } = params;

  const mindmap = await extractMindmap({ title, markdown });

  const { error } = await admin
    .from("documents")
    .update({ mindmap, mindmap_hash: hashMarkdown(markdown) })
    .eq("id", id)
    .eq("user_id", userId);

  if (error) throw new Error(error.message);

  return mindmap;
}
