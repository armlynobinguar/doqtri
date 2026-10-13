import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Decide a copy report (progress/004). Admins only (DOQTRI_ADMINS).
 * `uphold` hides the reported template from the gallery; `dismiss` leaves it;
 * `reopen` puts the report back in the queue (and unhides nothing — use the
 * template route for that). The contract listing is never touched.
 */
const ACTIONS = ["uphold", "dismiss", "reopen"] as const;
type Action = (typeof ACTIONS)[number];

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // 404 rather than 403: non-admins should not learn the route exists.
  if (!isAdmin(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { id } = await params;
  let action: unknown;
  try {
    ({ action } = (await request.json()) as { action?: unknown });
  } catch {
    // fall through
  }
  if (!ACTIONS.includes(action as Action)) return NextResponse.json({ error: "Invalid action." }, { status: 400 });

  const admin = createSupabaseAdminClient();
  const status = action === "uphold" ? "upheld" : action === "dismiss" ? "dismissed" : "open";
  const { data: report, error } = await admin
    .from("market_reports")
    .update({ status, reviewed_at: status === "open" ? null : new Date().toISOString() })
    .eq("id", id)
    .select("template_id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!report) return NextResponse.json({ error: "Report not found." }, { status: 404 });

  if (action === "uphold") {
    const { error: hideError } = await admin.from("market_templates").update({ hidden: true }).eq("id", report.template_id);
    if (hideError) return NextResponse.json({ error: hideError.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, status });
}
