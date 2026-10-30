import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { qditIntegrationEnabled } from "@/lib/integrations/qdit-config";
import { createQditClient, QditError, QditNotConnectedError, qditServerSetup } from "@/lib/integrations/qdit-client";
import { MILESTONE_CODES, NO_ACCESS_TEXT } from "@/lib/integrations/qdit-milestone-card";
import { loadMilestonePreview } from "@/lib/integrations/qdit-milestone-preview";
import { isUuid, noStoreJson } from "@/lib/integrations/qdit-route-context";

/**
 * One qdit milestone for the milestone card (WP-2.6), read from qdit as the
 * signed-in user with their own token. qdit decides what they may see, so
 * no doqtri role is checked: a doqtri member who cannot see the milestone in
 * qdit gets no access here too.
 *
 * Answers, all `no-store` (the short cache is on the server, per user and
 * qdit account; lib/integrations/qdit-milestone-preview.ts):
 *
 *   200 { milestone }                                   loaded
 *   403 { code: QDIT_NO_ACCESS }                        qdit said 403 or 404
 *   409 { code: QDIT_NOT_CONNECTED, connection }        connect or reconnect
 *   429 { code: QDIT_RATE_LIMITED } + Retry-After
 *   503 { code: QDIT_NOT_CONFIGURED }
 *   502 { code: QDIT_UNAVAILABLE }                      anything else from qdit
 */
export async function GET(_request: Request, context: RouteContext<"/api/integrations/qdit/milestones/[id]">) {
  if (!qditIntegrationEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const {
    data: { user },
  } = await (await createSupabaseServerClient()).auth.getUser();
  if (!user) return noStoreJson(401, { error: "Not signed in" });

  const { id } = await context.params;
  // Not a milestone id qdit could know: the same answer qdit's 404 gets.
  if (!isUuid(id)) return noStoreJson(403, { error: NO_ACCESS_TEXT, code: MILESTONE_CODES.noAccess });

  const setup = qditServerSetup();
  if (!setup) return noStoreJson(503, { error: "qdit isn't set up on this deployment.", code: "QDIT_NOT_CONFIGURED" });

  try {
    const outcome = await loadMilestonePreview({
      userId: user.id,
      milestoneId: id.toLowerCase(),
      store: setup.store,
      client: () => createQditClient(user.id, { config: setup.config, store: setup.store }),
    });
    return outcome.kind === "loaded"
      ? noStoreJson(200, { milestone: outcome.milestone })
      : noStoreJson(403, { error: NO_ACCESS_TEXT, code: MILESTONE_CODES.noAccess });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof QditNotConnectedError || (error instanceof QditError && error.kind === "unauthorized")) {
    // A second 401 after the refresh: qdit refuses the stored token, so the
    // connection is as good as broken.
    const connection = error instanceof QditNotConnectedError && error.connection === "none" ? "none" : "needs_reconnect";
    return noStoreJson(409, {
      error:
        connection === "none"
          ? "Connect your qdit account to see this milestone."
          : "Your qdit connection has expired or was revoked. Reconnect to see this milestone.",
      code: MILESTONE_CODES.notConnected,
      connection,
    });
  }
  if (error instanceof QditError) {
    if (error.kind === "not_configured") {
      return noStoreJson(503, { error: "qdit isn't set up on this deployment.", code: "QDIT_NOT_CONFIGURED" });
    }
    if (error.kind === "rate_limited") {
      const response = noStoreJson(429, { error: "qdit is busy. Try again in a moment.", code: "QDIT_RATE_LIMITED" });
      if (error.retryAfterSeconds !== null) response.headers.set("Retry-After", String(error.retryAfterSeconds));
      return response;
    }
    return noStoreJson(502, { error: "qdit couldn't be reached. Try again.", code: "QDIT_UNAVAILABLE" });
  }
  console.error(`[qdit-milestone] ${error instanceof Error ? error.message : String(error)}`);
  return noStoreJson(500, { error: "Something went wrong reading the milestone." });
}
