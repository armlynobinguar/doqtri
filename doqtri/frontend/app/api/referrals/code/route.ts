import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { createReferralCookie, normalizeReferralCode, REFERRAL_COOKIE, referralCookieOptions } from "@/lib/referral";

/**
 * A referral code typed into the sign-up form. Stores it in the same signed
 * cookie a shared link sets, so the referral is recorded after sign-up by
 * /api/referrals/claim, whichever way the visitor signs up. Unlike a link, an
 * unknown code is turned away here, so a typo can be corrected before
 * signing up.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return NextResponse.json({ error: "Server is not configured" }, { status: 500 });

  const body: unknown = await request.json().catch(() => null);
  const raw = body && typeof body === "object" && "code" in body ? body.code : null;
  const code = normalizeReferralCode(typeof raw === "string" ? raw : null);
  if (!code) {
    return NextResponse.json({ error: "A referral code is 8 letters and digits." }, { status: 400 });
  }

  // Service role: referral codes are readable only by their owner under RLS.
  const { data, error } = await createSupabaseAdminClient()
    .from("referral_codes")
    .select("code")
    .eq("code", code)
    .maybeSingle();
  if (error) {
    console.warn(`[referrals/code] ${error.message}`);
    return NextResponse.json({ error: "Could not check the code. Try again." }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "No one has that referral code." }, { status: 404 });
  }

  const response = NextResponse.json({ code });
  response.cookies.set(
    REFERRAL_COOKIE,
    createReferralCookie(code, Date.now(), "code", secret),
    referralCookieOptions(request.nextUrl.protocol === "https:"),
  );
  return response;
}

/** Forgets the code, from a link or typed in, before signing up. */
export async function DELETE() {
  const response = NextResponse.json({ code: null });
  response.cookies.delete(REFERRAL_COOKIE);
  return response;
}
