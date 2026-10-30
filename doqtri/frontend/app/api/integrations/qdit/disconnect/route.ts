import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { qditIntegrationEnabled } from "@/lib/integrations/qdit-config";
import { qditServerSetup } from "@/lib/integrations/qdit-client";
import { revokeToken } from "@/lib/integrations/qdit-oauth";

/**
 * Disconnects the signed-in user's qdit account (WP-2.3). Only their own:
 * the user id comes from the session, never from the request.
 *
 * The tokens are dropped in doqtri first, so the disconnect holds even if
 * the revocation below fails or the request is cut short. Then, best
 * effort, qdit is asked to revoke the refresh token (or the access token if
 * there was none). The contract defines no revocation call, so this works
 * only where qdit's auth server advertises one; the answer says whether it
 * did (`revoked_in_qdit`), so the profile can point the user to qdit's
 * Authorized apps to remove the grant there too.
 *
 * A POST: it changes state. The session cookie is SameSite=Lax, so another
 * site's form cannot send it here; a cross-origin Origin header is refused
 * as well.
 */
export async function POST(request: NextRequest) {
  if (!qditIntegrationEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const setup = qditServerSetup();
  if (!setup) return NextResponse.json({ error: "qdit isn't set up on this deployment." }, { status: 503 });

  let token: { value: string; hint: "refresh_token" | "access_token" } | null = null;
  try {
    // Two tries: a refresh may land between the read and the write.
    for (let attempt = 0; attempt < 2; attempt++) {
      const conn = await setup.store.load(user.id);
      if (!conn || conn.status === "revoked") break;
      if (await setup.store.markStatus(user.id, conn.generation, "revoked")) {
        token = conn.refreshToken
          ? { value: conn.refreshToken, hint: "refresh_token" }
          : conn.accessToken
            ? { value: conn.accessToken, hint: "access_token" }
            : null;
        break;
      }
      if (attempt === 1) throw new Error("the connection kept changing");
    }
  } catch (error) {
    console.error(`[qdit] disconnect failed: ${(error as Error).message}`);
    return NextResponse.json({ error: "Couldn't disconnect qdit. Try again." }, { status: 500 });
  }

  const revoked = token ? await revokeToken(setup.config, token.value, token.hint) : "unsupported";
  return NextResponse.json({ disconnected: true, revoked_in_qdit: revoked === "revoked" });
}
