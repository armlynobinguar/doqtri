import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { qditHackathonEnabled } from "@/lib/integrations/qdit-config";
import { createQditClient, QditError, qditServerSetup } from "@/lib/integrations/qdit-client";
import { fromQditError } from "@/lib/integrations/qdit-linking";
import { linkingErrorResponse, noStoreJson } from "@/lib/integrations/qdit-route-context";

/**
 * The hackathons qdit lists, for the "Send to qdit hackathon" dialog's
 * picker (WP-4.7, D-122): `{ hackathons: [{ slug, name, opens_at, closes_at,
 * state }] }` in qdit's order, from the signed-in user's qdit connection
 * (CONTRACT.md section 8, `GET /hackathons`). `state` is qdit's: `open`
 * takes a snapshot, `upcoming` has not opened, `other` is one doqtri does not
 * know.
 *
 * A qdit without that endpoint (before QDIT-60) answers 404 for the path:
 * then this answers `{ hackathons: null, list_unavailable: true }` and the
 * dialog asks for the hackathon's link instead.
 */
export async function GET() {
  if (!qditHackathonEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return noStoreJson(401, { error: "Not signed in" });

  const setup = qditServerSetup();
  if (!setup) return noStoreJson(503, { error: "qdit isn't set up on this deployment.", code: "QDIT_NOT_CONFIGURED" });

  try {
    const hackathons = await createQditClient(user.id, { config: setup.config, store: setup.store }).listHackathons();
    return noStoreJson(200, {
      hackathons: hackathons.map((h) => ({
        slug: h.slug,
        name: h.name,
        opens_at: h.opens_at,
        closes_at: h.closes_at,
        state: h.state,
      })),
    });
  } catch (error) {
    if (error instanceof QditError && error.kind === "not_found") {
      return noStoreJson(200, { hackathons: null, list_unavailable: true });
    }
    return linkingErrorResponse(fromQditError(error));
  }
}
