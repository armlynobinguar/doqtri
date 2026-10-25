import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { qditIntegrationEnabled } from "@/lib/integrations/qdit-config";
import { QditError, qditMeWithToken, qditServerSetup } from "@/lib/integrations/qdit-client";
import { connectedAppsPath, type QditErrorReason, type QditOutcome } from "@/lib/integrations/connected-apps";
import {
  checkOAuthState,
  exchangeCode,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE_PATH,
  OAuthGrantError,
} from "@/lib/integrations/qdit-oauth";

/**
 * Where qdit sends the browser back after consent (WP-2.3, D-02).
 *
 * In order: the state cookie must open and be unexpired, carry the `state`
 * qdit sent back, and belong to the doqtri user signed in now; only then is
 * qdit's answer looked at. A denial goes back to the profile as such. A code
 * is exchanged as a confidential client with the cookie's verifier, the
 * token's owner is read from GET /api/v1/me (and the token must be doqtri's,
 * by client_id), and the tokens are stored encrypted.
 *
 * Every answer is a redirect to Connected apps with a fixed outcome code
 * (lib/integrations/connected-apps.ts), and every answer clears the state
 * cookie, so a flow is used at most once. Nothing from qdit's error text, and
 * never a token, goes into the URL or the log.
 */
export async function GET(request: NextRequest) {
  if (!qditIntegrationEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const back = (outcome: QditOutcome, reason?: QditErrorReason) => {
    const response = NextResponse.redirect(new URL(connectedAppsPath(outcome, reason), request.url), 303);
    response.cookies.set(OAUTH_STATE_COOKIE, "", { path: OAUTH_STATE_COOKIE_PATH, maxAge: 0 });
    response.headers.set("Cache-Control", "no-store");
    return response;
  };

  const setup = qditServerSetup();
  if (!setup) return back("error", "not_configured");

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    const response = NextResponse.redirect(new URL("/login", request.url), 303);
    response.cookies.set(OAUTH_STATE_COOKIE, "", { path: OAUTH_STATE_COOKIE_PATH, maxAge: 0 });
    return response;
  }

  const params = request.nextUrl.searchParams;
  const checked = checkOAuthState(
    request.cookies.get(OAUTH_STATE_COOKIE)?.value,
    params.get("state"),
    user.id,
    setup.tokenKeys,
  );
  if (!checked.ok) {
    return back("error", checked.reason === "expired" ? "expired" : checked.reason === "other_user" ? "other_user" : "state");
  }

  const providerError = params.get("error");
  if (providerError) return back(providerError === "access_denied" ? "denied" : "error", "provider");
  const code = params.get("code");
  if (!code) return back("error", "provider");

  let tokens;
  try {
    tokens = await exchangeCode(setup.config, code, checked.state);
  } catch (error) {
    if (error instanceof OAuthGrantError) {
      console.warn(`[qdit] code exchange refused: ${error.error}`);
      return back("error", "exchange");
    }
    return back("error", "unavailable");
  }

  let me;
  try {
    me = await qditMeWithToken(setup.config, tokens.accessToken);
  } catch (error) {
    const kind = error instanceof QditError ? error.kind : "unknown";
    console.warn(`[qdit] account check failed: ${kind}`);
    return back("error", kind === "network" || kind === "timeout" || kind === "unavailable" ? "unavailable" : "account");
  }
  // A token minted for another client (another doqtri environment) is not ours to keep.
  if (me.client_id !== setup.config.clientId) {
    console.warn("[qdit] account check failed: token issued to another client");
    return back("error", "account");
  }

  try {
    await setup.store.saveConnected(
      user.id,
      { subject: me.user.id, accountLabel: me.user.username ?? me.user.display_name ?? null },
      tokens,
    );
  } catch (error) {
    console.error(`[qdit] storing the connection failed: ${(error as Error).message}`);
    return back("error", "unavailable");
  }
  return back("connected");
}
