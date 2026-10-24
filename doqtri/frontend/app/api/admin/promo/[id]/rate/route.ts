import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { rateAndStoreSubmission } from "@/lib/promo-rating-ai";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Rate, or re-rate, one promo entry now. Admins only (DOQTRI_ADMINS). Used for
 * entries whose automatic rating failed or was skipped, and after the rubric
 * changes. Not charged to any user's AI budget.
 */
export async function POST(
  _request: Request,
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
  try {
    const stored = await rateAndStoreSubmission(createSupabaseAdminClient(), id);
    if (!stored) return NextResponse.json({ error: "Entry not found." }, { status: 404 });
    return NextResponse.json(stored);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not rate that entry";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
