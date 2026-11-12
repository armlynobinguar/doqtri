import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readActiveWorkspaceCookie, resolveActiveWorkspace } from "@/lib/active-workspace";
import { roleAtLeast } from "@/lib/workspace-roles";
import {
  MINDMAP_SHARE_COPY as COPY,
  mindmapShareUrl,
  type MindmapShareListItem,
  type MindmapShareListResponse,
} from "@/lib/mindmap-share";
import { SITE_URL } from "@/lib/site-url";

/**
 * GET /api/mindmap-shares (WP-4.7, DOQ-53): the active workspace's live
 * mindmap links, newest first, for the Send to qdit hackathon dialog to list
 * with Revoke. Admins and owners only (D-10); the session client reads them,
 * so RLS on mindmap_shares decides too. Revoked links are left out.
 *
 * Not behind the hackathon flag: a link made while it was on must stay
 * revocable after it is switched off.
 */

/** The dialog lists at most this many, newest first. */
const LIST_LIMIT = 50;

const reply = (status: number, body: MindmapShareListResponse) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return reply(401, { ok: false, code: "NOT_SIGNED_IN", message: "Not signed in" });

  let workspace;
  try {
    ({ active: workspace } = await resolveActiveWorkspace(supabase, user.id, await readActiveWorkspaceCookie(user.id)));
  } catch (error) {
    console.error(`[mindmap-shares] ${(error as Error).message}`);
    return reply(500, { ok: false, code: "FAILED", message: COPY.listFailed });
  }
  if (!roleAtLeast(workspace.role, "admin")) return reply(403, { ok: false, code: "FORBIDDEN", message: COPY.forbidden });

  const { data, error } = await supabase
    .from("mindmap_shares")
    .select("id, token, created_at")
    .eq("workspace_id", workspace.id)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) {
    console.error(`[mindmap-shares] listing failed: ${error.message}`);
    return reply(500, { ok: false, code: "FAILED", message: COPY.listFailed });
  }

  const shares: MindmapShareListItem[] = ((data ?? []) as { id: string; token: string; created_at: string }[]).map(
    (row) => ({ id: row.id, url: mindmapShareUrl(SITE_URL, row.token), created_at: row.created_at }),
  );
  return reply(200, { ok: true, shares });
}
