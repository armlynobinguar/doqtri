import { adminAnswer, adminNotFound, adminUserId, logAdminFailure } from "@/lib/admin-route";
import { checkRewardAction, isUuid } from "@/lib/referral-payouts";
import { readJsonBody, restoreReward, voidReward } from "@/lib/referral-payouts-store";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

const MAX_BODY_BYTES = 4 * 1024;

/**
 * Void a reward, with a reason, or restore a void one (WP-4.6, DOQ-26). Voiding
 * frees a place, which the oldest over-limit reward takes; a restored reward is
 * eligible if there's a place, else over the limit. Admins only; a 404 for anyone
 * else, and for an id that isn't one.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await adminUserId())) return adminNotFound();
  const { id } = await params;
  if (!isUuid(id)) return adminNotFound();

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return adminAnswer({ error: body.reason === "too_large" ? "That's too long." : "Reload the page and try again." }, body.reason === "too_large" ? 413 : 400);
  }
  const checked = checkRewardAction(body.value);
  if (!checked.ok) return adminAnswer({ error: checked.error }, 400);

  try {
    const admin = createSupabaseAdminClient();
    if (checked.change.action === "void") {
      if (!(await voidReward(admin, id, checked.change.reason))) {
        return adminAnswer(
          { error: "This reward can't be voided: it's already paid or void. Reload to see it as it is now." },
          409,
        );
      }
      return adminAnswer({ status: "void" });
    }
    const restored = await restoreReward(admin, id);
    if (restored === "refused") {
      return adminAnswer(
        { error: "This reward can't be restored: its wallet already earned a reward, or its referrer deleted their account." },
        409,
      );
    }
    if (restored === "not_void") {
      return adminAnswer({ error: "Only a void reward can be restored. Reload to see it as it is now." }, 409);
    }
    return adminAnswer({ status: restored });
  } catch (error) {
    logAdminFailure("[admin/referrals] reward not changed", error);
    return adminAnswer({ error: "The reward couldn't be changed." }, 500);
  }
}
