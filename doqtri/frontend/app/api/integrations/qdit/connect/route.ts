import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { qditIntegrationEnabled, redirectUriFor } from "@/lib/integrations/qdit-config";
import { qditServerSetup } from "@/lib/integrations/qdit-client";
import { connectedAppsPath } from "@/lib/integrations/connected-apps";
import {
  authorizeUrl,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE_PATH,
  OAUTH_STATE_TTL_MS,
  startOAuthState,
} from "@/lib/integrations/qdit-oauth";

/**
 * Starts connecting the signed-in user's qdit account (WP-2.3, D-02): makes a
 * state and a PKCE verifier, seals them in a short-lived httpOnly cookie
 * bound to this user, and sends the browser to qdit's authorize endpoint.
 * Reconnecting is the same flow. The callback finishes it.
 *
 * A GET, so Connected apps can link to it. Another site can trigger it, but
 * all that does is show the user qdit's consent screen for their own
 * account; the code that comes back is only accepted with this cookie.
 */
export async function GET(request: NextRequest) {
  if (!qditIntegrationEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url), 303);

  const setup = qditServerSetup();
  if (!setup) {
    return NextResponse.redirect(new URL(connectedAppsPath("error", "not_configured"), request.url), 303);
  }

  const { state, cookie } = startOAuthState(
    user.id,
    redirectUriFor(setup.config, request.nextUrl.origin),
    setup.tokenKey,
  );
  const response = NextResponse.redirect(authorizeUrl(setup.config, state), 303);
  response.cookies.set(OAUTH_STATE_COOKIE, cookie, {
    httpOnly: true,
    // Lax, not strict: the cookie has to come back on qdit's top-level
    // redirect to the callback.
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: OAUTH_STATE_COOKIE_PATH,
    maxAge: OAUTH_STATE_TTL_MS / 1000,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
