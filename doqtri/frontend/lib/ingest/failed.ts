import type { SupabaseClient } from "@supabase/supabase-js";
import type { FailedImport } from "@/lib/types";

/** Past maxDuration (300 s) plus slack: a pending row this old was abandoned. */
const STALE_PENDING_MS = 6 * 60 * 1000;

/**
 * The caller's imports that never became notes: failed ones, plus pending ones
 * whose request must have died without reporting.
 *
 * Best-effort: a failed read (e.g. the ingests migration not applied yet) is
 * an empty list, so it can never take the vault down with it. Pass a
 * session-bound client; RLS scopes it to the caller.
 */
export async function loadFailedImports(supabase: SupabaseClient): Promise<FailedImport[]> {
  const staleBefore = new Date(Date.now() - STALE_PENDING_MS).toISOString();
  const { data } = await supabase
    .from("ingests")
    .select("id, filename, error_code")
    .or(`status.eq.failed,and(status.eq.pending,updated_at.lt.${staleBefore})`)
    .order("created_at", { ascending: false })
    .limit(20);
  return data ?? [];
}
