import { referralDashboardLive } from "@/lib/referral-dashboard";
import { hasEligibleReferral } from "@/lib/referral-payout-profiles";
import { readJsonBody } from "@/lib/referral-payouts-store";
import { validateTestimonial } from "@/lib/referral-testimonial";
import { logTestimonialFailure, readOwnTestimonial, saveTestimonial } from "@/lib/referral-testimonials-store";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };

/** 500 characters of four bytes each, escaped, with room to spare. */
const MAX_BODY_BYTES = 4 * 1024;

const NOT_ELIGIBLE = "Feedback opens once you have an eligible referral.";
const TOO_LARGE = "That's more than the feedback form can hold.";

function answer(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

/**
 * The user's feedback and their opt-in to show it (WP-4.6, DOQ-28, D-113), for
 * the payout questionnaire. Whose comes only from the session. A 404 until the
 * legal pages go live, signed in or not, like the questionnaire's own route.
 * Open to the same people: an eligible referral, or a testimonial already
 * stored, which the owner can still see.
 */
export async function GET() {
  if (!referralDashboardLive()) return answer({ error: "Not found" }, 404);

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return answer({ error: "Sign in to continue." }, 401);

  try {
    // The row through the user's own session, where RLS decides; the rewards are
    // service role only, and user.id comes from the verified session above.
    const [testimonial, canEdit] = await Promise.all([
      readOwnTestimonial(supabase, user.id),
      hasEligibleReferral(createSupabaseAdminClient(), user.id, NETWORK),
    ]);
    if (!testimonial && !canEdit) return answer({ error: NOT_ELIGIBLE }, 403);
    return answer({ testimonial, canEdit });
  } catch (error) {
    logTestimonialFailure("[referrals] feedback not loaded", error);
    return answer({ error: "Your feedback couldn't be loaded." }, 500);
  }
}

/**
 * Saves the feedback and the opt-in after checking them here. No feedback
 * deletes it. Separate from the payout details' route, so their eligibility and
 * checks stay exactly as they are. Withdrawing is never refused: someone who no
 * longer has an eligible referral can still untick the box or delete their
 * feedback, but not write new words or opt in.
 */
export async function PUT(request: Request) {
  if (!referralDashboardLive()) return answer({ error: "Not found" }, 404);

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return answer({ error: "Sign in to continue." }, 401);

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return body.reason === "too_large"
      ? answer({ error: TOO_LARGE }, 413)
      : answer({ error: "Check your feedback and try again." }, 400);
  }

  try {
    // Service role from here on: user.id comes from the verified session above.
    const admin = createSupabaseAdminClient();
    const eligible = await hasEligibleReferral(admin, user.id, NETWORK);
    const current = eligible ? null : await readOwnTestimonial(admin, user.id);
    if (!eligible && !current) return answer({ error: NOT_ELIGIBLE }, 403);

    const checked = validateTestimonial(body.value);
    if (!checked.ok) return answer({ error: "Check the highlighted details.", fields: checked.errors }, 400);

    if (!eligible) {
      const { feedback, consent } = checked.value;
      const withdrawing = !consent && (feedback === null || feedback === current!.feedback);
      if (!withdrawing) return answer({ error: NOT_ELIGIBLE }, 403);
    }

    return answer({ testimonial: await saveTestimonial(admin, user.id, checked.value) });
  } catch (error) {
    logTestimonialFailure("[referrals] feedback not saved", error);
    return answer({ error: "Your feedback couldn't be saved." }, 500);
  }
}
