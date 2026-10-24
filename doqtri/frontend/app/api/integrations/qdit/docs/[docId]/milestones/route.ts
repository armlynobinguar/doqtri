import { adoptMilestoneLink, createMilestoneLink } from "@/lib/integrations/qdit-linking";
import {
  isUuid,
  linkingErrorResponse,
  noStoreJson,
  qditRouteContext,
  readBody,
} from "@/lib/integrations/qdit-route-context";

/**
 * Links one of the note's headings to a qdit milestone (WP-2.5). Editors and
 * above of the note's workspace; qdit asks for member or above in the
 * project (D-23).
 *
 * `{ nodeId }` creates a milestone titled after the heading, as the saved
 * note has it (the ship panel saves first). `{ nodeId, milestoneId }` takes
 * over a milestone qdit already links to this note. `nodeLabel`, the
 * heading's text as the user picked it, is refused when the saved note has
 * other text at that id (ids are positional). Answers `{ link }`.
 */
export async function POST(request: Request, context: RouteContext<"/api/integrations/qdit/docs/[docId]/milestones">) {
  const { docId } = await context.params;
  const found = await qditRouteContext(docId, "editor");
  if (!found.ok) return found.response;
  const body = await readBody(request);
  const nodeId = typeof body?.nodeId === "string" ? body.nodeId : null;
  if (!nodeId) return noStoreJson(400, { error: "Pick a heading." });
  const nodeLabel = typeof body?.nodeLabel === "string" ? body.nodeLabel : undefined;
  if (body?.milestoneId !== undefined && !isUuid(body.milestoneId)) {
    return noStoreJson(400, { error: "That isn't a qdit milestone id." });
  }

  const { admin, client, userId, doc, chainVersion } = found.ctx;
  try {
    const link = isUuid(body?.milestoneId)
      ? await adoptMilestoneLink({
          admin,
          client,
          userId,
          doc,
          nodeId,
          nodeLabel,
          milestoneId: body.milestoneId.toLowerCase(),
          chainVersion,
        })
      : await createMilestoneLink({ admin, client, userId, doc, nodeId, nodeLabel, chainVersion });
    return noStoreJson(201, { link });
  } catch (error) {
    return linkingErrorResponse(error);
  }
}
