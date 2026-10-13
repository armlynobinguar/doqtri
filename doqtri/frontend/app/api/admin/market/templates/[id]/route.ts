import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

/** Hide or unhide a community template in the gallery. Admins only. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isAdmin(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { id } = await params;
  let hidden: unknown;
  try {
    ({ hidden } = (await request.json()) as { hidden?: unknown });
  } catch {
    // fall through
  }
  if (typeof hidden !== "boolean") return NextResponse.json({ error: "hidden must be true or false." }, { status: 400 });

  const { data, error } = await createSupabaseAdminClient()
    .from("market_templates")
    .update({ hidden })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Template not found." }, { status: 404 });
  return NextResponse.json({ ok: true, hidden });
}
