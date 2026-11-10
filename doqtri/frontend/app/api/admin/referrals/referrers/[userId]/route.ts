import { adminAnswer, adminNotFound, adminUserId, logAdminFailure } from "@/lib/admin-route";
import { checkLimit, isUuid } from "@/lib/referral-payouts";
import { readJsonBody, setRewardLimit } from "@/lib/referral-payouts-store";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

const MAX_BODY_BYTES = 1024;

/**
 * Set a referrer's reward limit (WP-4.6, DOQ-26), after they've asked
 * team@doqtri.xyz for more. Raising it moves their oldest over-limit rewards up to
 * eligible; lowering it never changes a reward already eligible or paid. Admins
 * only; a 404 for anyone else, for an id that isn't one, and for no such user.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  if (!(await adminUserId())) return adminNotFound();
  const { userId } = await params;
  if (!isUuid(userId)) return adminNotFound();

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return adminAnswer({ error: body.reason === "too_large" ? "That's too long." : "Reload the page and try again." }, body.reason === "too_large" ? 413 : 400);
  }
  const checked = checkLimit((body.value as { limit?: unknown } | null)?.limit);
  if (!checked.ok) return adminAnswer({ error: checked.error }, 400);

  try {
    if (!(await setRewardLimit(createSupabaseAdminClient(), userId, checked.limit))) return adminNotFound();
    return adminAnswer({ limit: checked.limit });
  } catch (error) {
    logAdminFailure("[admin/referrals] limit not set", error);
    return adminAnswer({ error: "The limit couldn't be set." }, 500);
  }
}
