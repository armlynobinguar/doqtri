import { NextResponse, type NextRequest } from "next/server";
import { createReferralCookie, normalizeReferralCode, REFERRAL_COOKIE, referralCookieOptions } from "@/lib/referral";

/**
 * A shared referral link, /r/<code>, or its QR code, /r/<code>?via=qr.
 * Remembers the code in a signed cookie and sends the visitor on to sign up;
 * the referral is recorded after they do (/api/referrals/claim). Whether the
 * code belongs to anyone is checked then too, so an unknown code simply
 * records nothing.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const code = normalizeReferralCode(raw);
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const source = request.nextUrl.searchParams.get("via") === "qr" ? "qr" : "link";

  const response = NextResponse.redirect(new URL(code ? "/signup" : "/", request.url));
  if (code && secret) {
    response.cookies.set(
      REFERRAL_COOKIE,
      createReferralCookie(code, Date.now(), source, secret),
      referralCookieOptions(request.nextUrl.protocol === "https:"),
    );
  }
  return response;
}
