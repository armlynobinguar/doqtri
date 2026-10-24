import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { qditIntegrationEnabled } from "@/lib/integrations/qdit-config";
import { createQditClient, qditServerSetup } from "@/lib/integrations/qdit-client";
import { fromQditError } from "@/lib/integrations/qdit-linking";
import { linkingErrorResponse, noStoreJson } from "@/lib/integrations/qdit-route-context";

/**
 * The signed-in user's qdit projects, for the ship panel's project picker
 * (WP-2.5). Only what the picker shows: qdit's own role decides who may link
 * a note to which project (D-23), and `can_link` says so up front.
 */
export async function GET() {
  if (!qditIntegrationEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return noStoreJson(401, { error: "Not signed in" });

  const setup = qditServerSetup();
  if (!setup) return noStoreJson(503, { error: "qdit isn't set up on this deployment.", code: "QDIT_NOT_CONFIGURED" });

  try {
    const projects = await createQditClient(user.id, { config: setup.config, store: setup.store }).listAllProjects();
    return noStoreJson(200, {
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        status: p.status,
        role: p.role,
        can_link: p.role === "admin" || p.role === "owner",
      })),
    });
  } catch (error) {
    return linkingErrorResponse(fromQditError(error));
  }
}
