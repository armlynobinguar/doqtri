import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { isPromoStatus } from "@/lib/promo";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";

/** Set a promo entry's review status. Admins only (DOQTRI_ADMINS). */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // 404 rather than 403: non-admins should not learn the route exists.
  if (!isAdmin(user)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { id } = await params;
  let status: unknown;
  try {
    ({ status } = (await request.json()) as { status?: unknown });
  } catch {
    // fall through to the status check
  }
  if (!isPromoStatus(status)) {
    return NextResponse.json({ error: "Invalid status." }, { status: 400 });
  }

  const { data, error } = await createSupabaseAdminClient()
    .from("promo_submissions")
    .update({
      status,
      reviewed_at: status === "pending" ? null : new Date().toISOString(),
    })
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Entry not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
