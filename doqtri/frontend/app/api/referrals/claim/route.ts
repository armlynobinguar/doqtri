import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { readReferralCookie, REFERRAL_COOKIE } from "@/lib/referral";

/**
 * Records who referred the signed-in user, from the cookie /r/<code> set.
 * Called once by the vault when that cookie is present, whichever way the
 * user signed up. The cookie is cleared once it has been handled, whether or
 * not it counted; claim_referral() decides that (a new account, not the
 * user's own code, no earlier referrer).
 */
export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return NextResponse.json({ error: "Server is not configured" }, { status: 500 });

  const raw = request.cookies.get(REFERRAL_COOKIE)?.value;
  const referral = readReferralCookie(raw, secret);

  let claimed = false;
  if (referral) {
    // Service role from here on: user.id comes from the verified session above.
    const { data, error } = await createSupabaseAdminClient().rpc("claim_referral", {
      p_user_id: user.id,
      p_code: referral.code,
      p_clicked_at: new Date(referral.openedAt).toISOString(),
      p_source: referral.source,
    });
    if (error) {
      // Keep the cookie so the next visit can try again.
      console.warn(`[referrals/claim] ${error.message}`);
      return NextResponse.json({ error: "Could not record the referral" }, { status: 500 });
    }
    claimed = data === true;
  }

  const response = NextResponse.json({ claimed });
  if (raw !== undefined) response.cookies.delete(REFERRAL_COOKIE);
  return response;
}
