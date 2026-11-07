import { referralDashboardLive } from "@/lib/referral-dashboard";
import { payoutSummary, validatePayoutProfile } from "@/lib/referral-payout";
import { hasEligibleReferral, PayoutStoreError, readPayoutProfile, savePayoutProfile } from "@/lib/referral-payout-profiles";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };

/** Far more than the longest valid form. */
const MAX_BODY_CHARS = 8 * 1024;

const NOT_ELIGIBLE = "Payout details open once you have an eligible referral.";

function answer(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

/**
 * The label and the database's error code, and nothing else: no message or
 * object, since these are financial details and a message could quote a row.
 */
function logFailure(label: string, error: unknown) {
  console.error(label, error instanceof PayoutStoreError ? error.code : "unexpected");
}

/**
 * A referrer's payout details, in full, for the form (WP-4.6, DOQ-25, D-112). Whose
 * comes only from the session. A 404 until the legal pages go live, signed in or
 * not, like the dashboard. Without an eligible referral it's a 403, unless a row
 * is already stored: then the owner can still see it, but not change it.
 */
export async function GET() {
  if (!referralDashboardLive()) return answer({ error: "Not found" }, 404);

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return answer({ error: "Sign in to continue." }, 401);

  try {
    // The row through the user's own session, where RLS decides. The rewards are
    // service role only, and user.id comes from the verified session above.
    const [profile, canEdit] = await Promise.all([
      readPayoutProfile(supabase, user.id),
      hasEligibleReferral(createSupabaseAdminClient(), user.id, NETWORK),
    ]);
    if (!profile && !canEdit) return answer({ error: NOT_ELIGIBLE }, 403);
    return answer({ profile, canEdit });
  } catch (error) {
    logFailure("[referrals] payout details not loaded", error);
    return answer({ error: "Your payout details couldn't be loaded." }, 500);
  }
}

/**
 * Saves the details after checking them here, whatever the form did. Eligibility
 * comes first, so someone without it learns nothing from the validator. A user_id
 * in the body goes nowhere: the validator keeps only the form's fields.
 */
export async function PUT(request: Request) {
  if (!referralDashboardLive()) return answer({ error: "Not found" }, 404);

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return answer({ error: "Sign in to continue." }, 401);

  try {
    // Service role from here on: user.id comes from the verified session above.
    const admin = createSupabaseAdminClient();
    if (!(await hasEligibleReferral(admin, user.id, NETWORK))) return answer({ error: NOT_ELIGIBLE }, 403);

    const body = parseBody(await request.text());
    if (body === undefined) return answer({ error: "Check your details and try again." }, 400);

    const result = validatePayoutProfile(body);
    if (!result.ok) return answer({ error: "Check the highlighted details.", fields: result.errors }, 400);

    await savePayoutProfile(admin, user.id, result.profile);
    return answer({ summary: payoutSummary(result.profile) });
  } catch (error) {
    logFailure("[referrals] payout details not saved", error);
    return answer({ error: "Your payout details couldn't be saved." }, 500);
  }
}

/** Undefined for what can't be a form. A parser's error can quote the text, so it goes no further. */
function parseBody(text: string): unknown {
  if (text.length > MAX_BODY_CHARS) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
