import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/email-auth";

/**
 * Where Supabase's emailed links land (sign-up confirmation, password reset).
 * Turns the link into session cookies, then continues to `next`.
 *
 * Two link shapes, depending on the email template:
 * - default `{{ .ConfirmationURL }}`: Supabase verifies, then redirects here
 *   with a PKCE `code` (only exchangeable in the browser that asked for it);
 * - custom `?token_hash={{ .TokenHash }}&type=…`: verified here, any browser.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNextPath(searchParams.get("next"));
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const supabase = await createSupabaseServerClient();
  let failed = true;
  if (code) {
    failed = Boolean((await supabase.auth.exchangeCodeForSession(code)).error);
  } else if (tokenHash && type) {
    failed = Boolean((await supabase.auth.verifyOtp({ token_hash: tokenHash, type })).error);
  }

  if (failed) {
    return NextResponse.redirect(new URL("/login?error=link", origin));
  }
  return NextResponse.redirect(new URL(next, origin));
}
