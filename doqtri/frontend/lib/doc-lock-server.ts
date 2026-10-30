import type { SupabaseClient } from "@supabase/supabase-js";
import { isLockLive } from "@/lib/doc-lock";

/**
 * Server-side lock checks for routes that write a note through the service
 * role (WP-1.6, D-17). The service role is not stopped by the database's
 * lock rules, so these routes ask here first.
 */

/** Who holds a note's lock right now, or null when it is free. */
export async function liveLockHolder(
  admin: SupabaseClient,
  docId: string,
  now: number = Date.now(),
): Promise<{ holder: string | null; error: string | null }> {
  const { data, error } = await admin
    .from("doc_locks")
    .select("holder, heartbeat_at")
    .eq("document_id", docId)
    .maybeSingle();
  if (error) return { holder: null, error: error.message };
  const row = data as { holder: string; heartbeat_at: string } | null;
  if (!row || !isLockLive(row.heartbeat_at, now)) return { holder: null, error: null };
  return { holder: row.holder, error: null };
}
