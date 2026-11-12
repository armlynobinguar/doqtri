import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/integrations/qdit-route-context";
import { MINDMAP_SHARE_COPY as COPY } from "@/lib/mindmap-share";

/**
 * POST /api/mindmap-shares/{id}/revoke (WP-4.7, DOQ-53): revokes one mindmap
 * link, so /m/<token> is a 404 from the next request on. The row stays, as a
 * revoked link (the migration keeps it revoked for good).
 *
 * Written with the caller's session: RLS lets only an admin or owner of the
 * link's workspace update it, and only its revoked_at. A link the caller may
 * not revoke, an unknown one and one already revoked all read as 404, so the
 * answer never says whether someone else's link exists.
 */

const reply = (status: number, body: { ok: true } | { ok: false; code: string; message: string }) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(_request: Request, context: RouteContext<"/api/mindmap-shares/[id]/revoke">) {
  const { id } = await context.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return reply(401, { ok: false, code: "NOT_SIGNED_IN", message: "Not signed in" });
  if (!isUuid(id)) return reply(404, { ok: false, code: "NOT_FOUND", message: COPY.notFound });

  const { data, error } = await supabase
    .from("mindmap_shares")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .is("revoked_at", null)
    .select("id");
  if (error) {
    console.error(`[mindmap-shares] revoke failed: ${error.message}`);
    return reply(500, { ok: false, code: "FAILED", message: COPY.revokeFailed });
  }
  if (!data || data.length === 0) return reply(404, { ok: false, code: "NOT_FOUND", message: COPY.notFound });
  return reply(200, { ok: true });
}
