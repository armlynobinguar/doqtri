import { adminAnswer, adminNotFound, adminUserId, logAdminFailure } from "@/lib/admin-route";
import { readJsonBody } from "@/lib/referral-payouts-store";
import { checkTestimonialReview } from "@/lib/referral-testimonial";
import { loadTestimonialsForReview, reviewTestimonial, type TestimonialReviewResult } from "@/lib/referral-testimonials-store";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

const MAX_BODY_BYTES = 4 * 1024;

const REFUSED: Record<Exclude<TestimonialReviewResult, "approved" | "rejected">, string> = {
  changed: "This feedback changed or was removed since the page loaded. Nothing was changed: reload to review it as it is now.",
  private: "This feedback isn't shared publicly, so it can't be approved or rejected. Reload to see it as it is now.",
  no_name:
    "This referrer has no name in their payout details, so there is no name to approve it under. Nothing was changed: it can be approved once they save one.",
  admin_gone: "Your admin account no longer exists, so nothing was changed. Sign in again.",
};

/**
 * Referral testimonials for review (WP-4.6, DOQ-28, D-113): every one, private
 * feedback included, waiting for review first. Admins only; a 404 for anyone
 * else, signed out included. Not behind the legal pages' switch, like the rest
 * of the payouts panel: approving shows nothing publicly until it's on.
 */
export async function GET() {
  if (!(await adminUserId())) return adminNotFound();
  try {
    return adminAnswer({ rows: await loadTestimonialsForReview(createSupabaseAdminClient()) });
  } catch (error) {
    logAdminFailure("[admin/referrals] testimonials not loaded", error);
    return adminAnswer({ error: "The testimonials couldn't be loaded." }, 500);
  }
}

/**
 * Approve or reject one, as it was when the admin read it: `version` is the row's
 * version from the list, so text edited since is refused, not approved unseen.
 */
export async function POST(request: Request) {
  const adminId = await adminUserId();
  if (!adminId) return adminNotFound();

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return adminAnswer(
      { error: body.reason === "too_large" ? "That's too long." : "Reload the page and try again." },
      body.reason === "too_large" ? 413 : 400,
    );
  }
  const checked = checkTestimonialReview(body.value);
  if (!checked.ok) return adminAnswer({ error: checked.error }, 400);

  try {
    const result = await reviewTestimonial(createSupabaseAdminClient(), checked.value, adminId);
    if (result === "approved" || result === "rejected") return adminAnswer({ status: result });
    return adminAnswer({ error: REFUSED[result] }, 409);
  } catch (error) {
    logAdminFailure("[admin/referrals] testimonial not reviewed", error);
    return adminAnswer({ error: "The testimonial couldn't be changed." }, 500);
  }
}
