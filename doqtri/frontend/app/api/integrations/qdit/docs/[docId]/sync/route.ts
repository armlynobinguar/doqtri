import { syncQditLinks } from "@/lib/integrations/qdit-linking";
import { linkingErrorResponse, noStoreJson, qditRouteContext } from "@/lib/integrations/qdit-route-context";

/**
 * Retry (WP-2.5): tells qdit about the note's links that are still
 * `pending` after a save, as the caller (editors and above). A sync already
 * running for the note answers `skipped`, and picks the changes up itself.
 */
export async function POST(_request: Request, context: RouteContext<"/api/integrations/qdit/docs/[docId]/sync">) {
  const { docId } = await context.params;
  const found = await qditRouteContext(docId, "editor");
  if (!found.ok) return found.response;
  const { admin, client, doc, chainVersion } = found.ctx;
  try {
    const result = await syncQditLinks({ admin, client, docId: doc.id, chainVersion });
    return noStoreJson(200, result);
  } catch (error) {
    return linkingErrorResponse(error);
  }
}
