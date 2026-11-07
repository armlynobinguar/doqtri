import { logError } from "@/lib/log-error";
import { loadReferralDashboard, referralDashboardLive, referralPage } from "@/lib/referral-dashboard";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };

function answer(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

/**
 * The signed-in user's referral dashboard (WP-4.6, DOQ-24, D-111). Whose it is
 * comes only from the session, never the request. A 404 until the legal pages
 * go live, signed in or not.
 */
export async function GET(request: Request) {
  if (!referralDashboardLive()) return answer({ error: "Not found" }, 404);

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return answer({ error: "Sign in to continue." }, 401);

  try {
    const page = referralPage(new URL(request.url).searchParams.get("page"));
    // Service role from here on: user.id comes from the verified session above.
    return answer(await loadReferralDashboard(createSupabaseAdminClient(), user.id, NETWORK, page));
  } catch (error) {
    logError("[referrals] dashboard not loaded", error);
    return answer({ error: "Your referrals couldn't be loaded." }, 500);
  }
}
