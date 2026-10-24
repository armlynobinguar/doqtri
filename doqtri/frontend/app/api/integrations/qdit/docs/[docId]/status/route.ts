import { roleAtLeast } from "@/lib/workspace-roles";
import {
  readChainOverRpc,
  recheckDocStatuses,
  supabaseStatusStore,
} from "@/lib/integrations/qdit-status-sync";
import { linkingErrorResponse, noStoreJson, qditRouteContext, readBody } from "@/lib/integrations/qdit-route-context";

/**
 * The ship panel's re-check (WP-2.8, R-09): reads every linked milestone of
 * the note again, from milestone_proof (D-04) and from qdit as the caller
 * (their own project roles apply, D-23), records what it found, and answers
 * `{ states, errors }`, the qdit_milestone_states rows by milestone id.
 * Any member of the note's workspace, viewers included: they see the
 * suggestion, not the button (D-14). Without a qdit connection the chain
 * still answers.
 *
 * `{ force: true }` skips the freshness windows, so an editor's signature
 * follows a read made just before it; viewers' requests never force.
 */
export async function POST(request: Request, context: RouteContext<"/api/integrations/qdit/docs/[docId]/status">) {
  const { docId } = await context.params;
  const found = await qditRouteContext(docId, "viewer");
  if (!found.ok) return found.response;
  const { admin, client, doc, role } = found.ctx;
  const body = await readBody(request);
  const force = body?.force === true && roleAtLeast(role, "editor");
  try {
    const result = await recheckDocStatuses({
      store: supabaseStatusStore(admin),
      client,
      docId: doc.id,
      readChain: readChainOverRpc,
      force,
    });
    return noStoreJson(200, result);
  } catch (error) {
    return linkingErrorResponse(error);
  }
}
