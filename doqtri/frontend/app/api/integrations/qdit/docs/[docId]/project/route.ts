import { SITE_URL } from "@/lib/site-url";
import { linkProject, unlinkProject } from "@/lib/integrations/qdit-linking";
import {
  isUuid,
  linkingErrorResponse,
  noStoreJson,
  qditRouteContext,
  readBody,
} from "@/lib/integrations/qdit-route-context";

/**
 * The note's qdit project (WP-2.5, D-09). Only an admin or owner of the
 * note's workspace links or unlinks it (D-10), and qdit asks the same of
 * their role in the project (D-23).
 *
 * POST `{ projectId }` links the note (re-posting refreshes the title qdit
 * shows); DELETE unlinks it, and with it every milestone link of the note
 * (D-22). Answers `{ project }`, or `{ removed_link_ids }` for a DELETE.
 * DELETE `?forget=1`, sent once the admin confirmed it after a
 * QDIT_UNCONFIRMED answer, forgets the link here when qdit no longer shows
 * the project, and adds `{ forgotten: true, dangling_link_ids }`.
 */
export async function POST(request: Request, context: RouteContext<"/api/integrations/qdit/docs/[docId]/project">) {
  const { docId } = await context.params;
  const found = await qditRouteContext(docId, "admin");
  if (!found.ok) return found.response;
  const body = await readBody(request);
  if (!isUuid(body?.projectId)) return noStoreJson(400, { error: "Pick a qdit project." });

  const { admin, client, userId, doc } = found.ctx;
  try {
    const project = await linkProject({
      admin,
      client,
      userId,
      doc,
      projectId: body.projectId.toLowerCase(),
      siteUrl: SITE_URL,
    });
    return noStoreJson(200, { project });
  } catch (error) {
    return linkingErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext<"/api/integrations/qdit/docs/[docId]/project">) {
  const { docId } = await context.params;
  const found = await qditRouteContext(docId, "admin");
  if (!found.ok) return found.response;
  const { admin, client, doc } = found.ctx;
  try {
    const forgetIfGone = new URL(request.url).searchParams.get("forget") === "1";
    const { removedLinkIds, danglingLinkIds } = await unlinkProject({ admin, client, docId: doc.id, forgetIfGone });
    return noStoreJson(
      200,
      danglingLinkIds
        ? { removed_link_ids: removedLinkIds, forgotten: true, dangling_link_ids: danglingLinkIds }
        : { removed_link_ids: removedLinkIds },
    );
  } catch (error) {
    return linkingErrorResponse(error);
  }
}
