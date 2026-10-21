import type { SupabaseClient } from "@supabase/supabase-js";
import type { SavedStyle } from "@/lib/mindmap-style-sync";

/**
 * The caller's saved studio style for one map (`global` or `doc:<id>`), for a
 * mindmap page to hand to its studio so the first paint has the user's look.
 *
 * A failed read is not fatal: the map still opens, in the default look, and
 * `loaded: false` stops the studio from treating the missing row as "never
 * styled" and overwriting whatever the server really has.
 *
 * Pass a session-bound client: RLS is what scopes this to the caller.
 */
export async function loadMindmapStyle(
  supabase: SupabaseClient,
  userId: string,
  scope: string,
): Promise<SavedStyle> {
  const { data, error } = await supabase
    .from("mindmap_styles")
    .select("style, updated_at")
    .eq("user_id", userId)
    .eq("scope", scope)
    .maybeSingle();

  if (error) return { userId, style: null, updatedAt: null, loaded: false };
  return {
    userId,
    style: data?.style ?? null,
    updatedAt: data?.updated_at ?? null,
    loaded: true,
  };
}
