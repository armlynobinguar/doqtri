import { NextResponse } from "next/server";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { qditIntegrationEnabled } from "@/lib/integrations/qdit-config";
import { relinkMilestone, syncQditLinks, unlinkMilestone } from "@/lib/integrations/qdit-linking";
import {
  isUuid,
  linkingErrorResponse,
  noStoreJson,
  qditRouteContext,
  readBody,
} from "@/lib/integrations/qdit-route-context";
import { QDIT_LINK_COLUMNS, type QditLinkRow } from "@/lib/node-links";

/**
 * One heading's qdit link (WP-2.5), by its node_links id. Editors and above
 * of the note's workspace.
 *
 * DELETE unlinks the heading; the milestone stays in qdit. PATCH
 * `{ nodeId, nodeLabel? }` points the link at another heading (how an ambiguous, broken
 * or conflicting link is settled) and tells qdit at once. Answers `{ link }`
 * for a PATCH, with what the sync could not do in `failed`.
 */

async function load(id: string) {
  if (!qditIntegrationEnabled()) return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  // Signed in first, as every other route: the lookup below must not tell a
  // stranger which link ids exist.
  const {
    data: { user },
  } = await (await createSupabaseServerClient()).auth.getUser();
  if (!user) return { response: noStoreJson(401, { error: "Not signed in" }) };
  if (!isUuid(id)) return { response: noStoreJson(404, { error: "Link not found" }) };
  // Only to find the note; qditRouteContext() then checks the caller's role
  // in its workspace before anything is returned or changed.
  const { data, error } = await createSupabaseAdminClient()
    .from("node_links")
    .select(`document_id, ${QDIT_LINK_COLUMNS}`)
    .eq("id", id)
    .eq("provider", "qdit")
    .maybeSingle();
  if (error) return { response: noStoreJson(500, { error: error.message }) };
  if (!data) return { response: noStoreJson(404, { error: "Link not found" }) };
  const found = await qditRouteContext((data as { document_id: string }).document_id, "editor");
  if (!found.ok) {
    // A link on a note the caller cannot see does not exist for them.
    return { response: found.response.status === 404 ? noStoreJson(404, { error: "Link not found" }) : found.response };
  }
  return { row: data as unknown as QditLinkRow, ctx: found.ctx };
}

export async function DELETE(_request: Request, context: RouteContext<"/api/integrations/qdit/links/[id]">) {
  const { id } = await context.params;
  const loaded = await load(id);
  if (!loaded.row) return loaded.response;
  try {
    await unlinkMilestone({ admin: loaded.ctx.admin, client: loaded.ctx.client, row: loaded.row });
    return noStoreJson(200, { ok: true });
  } catch (error) {
    return linkingErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext<"/api/integrations/qdit/links/[id]">) {
  const { id } = await context.params;
  const body = await readBody(request);
  const nodeId = typeof body?.nodeId === "string" ? body.nodeId : null;
  if (!nodeId) return noStoreJson(400, { error: "Pick a heading." });
  const nodeLabel = typeof body?.nodeLabel === "string" ? body.nodeLabel : undefined;
  const loaded = await load(id);
  if (!loaded.row) return loaded.response;
  const { admin, client, doc, chainVersion } = loaded.ctx;
  try {
    const link = await relinkMilestone({ admin, doc, row: loaded.row, nodeId, nodeLabel });
    const sync = await syncQditLinks({ admin, client, docId: doc.id, chainVersion });
    return noStoreJson(200, { link, failed: sync.failed.filter((f) => f.id === link.id) });
  } catch (error) {
    return linkingErrorResponse(error);
  }
}
