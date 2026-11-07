import { adminAnswer, adminNotFound, adminUserId, logAdminFailure } from "@/lib/admin-route";
import { checkMarkPaid, isUuid } from "@/lib/referral-payouts";
import { loadPayoutQueue, loadPayoutReferrals, markRewardsPaid, readJsonBody } from "@/lib/referral-payouts-store";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** A thousand reward ids and the rest, with room to spare. */
const MAX_BODY_BYTES = 64 * 1024;

const REFUSED = {
  stale: "These rewards changed since the page loaded. Reload to see them as they are now; nothing was recorded.",
  no_details: "This referrer hasn't added payout details yet, so there is nowhere to pay.",
  details_changed:
    "The payout details changed since the page loaded. Reload and check them before marking as paid; nothing was recorded.",
  invalid: "Check the reference: up to 100 characters, with no line breaks or special characters.",
} as const;

/**
 * The payout queue (WP-4.6, DOQ-26), or with `?referrer=<id>` everyone that
 * referrer referred, in full, for review. Admins only; a 404 for anyone else.
 * Holds payout details in full, so never cached.
 */
export async function GET(request: Request) {
  if (!(await adminUserId())) return adminNotFound();

  const referrer = new URL(request.url).searchParams.get("referrer");
  if (referrer !== null && !isUuid(referrer)) return adminNotFound();

  try {
    const admin = createSupabaseAdminClient();
    if (referrer) return adminAnswer({ referrals: await loadPayoutReferrals(admin, referrer, NETWORK) });
    return adminAnswer({ rows: await loadPayoutQueue(admin) });
  } catch (error) {
    logAdminFailure("[admin/referrals] payouts not loaded", error);
    return adminAnswer({ error: "The payout queue couldn't be loaded." }, 500);
  }
}

/**
 * Mark as paid: records that an admin paid exactly these rewards, by hand. Nothing
 * is sent from here. The rewards, their total and the details' version are what
 * the admin saw; the database refuses the lot if any of them has changed since.
 */
export async function POST(request: Request) {
  const paidBy = await adminUserId();
  if (!paidBy) return adminNotFound();

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return body.reason === "too_large"
      ? adminAnswer({ error: "That's more than a payout can hold." }, 413)
      : adminAnswer({ error: "Reload the page and try again." }, 400);
  }
  const checked = checkMarkPaid(body.value);
  if (!checked.ok) return adminAnswer({ error: checked.error }, 400);

  try {
    const result = await markRewardsPaid(createSupabaseAdminClient(), checked.request, paidBy);
    if (!result.ok) return adminAnswer({ error: REFUSED[result.refusal] }, result.refusal === "invalid" ? 400 : 409);
    return adminAnswer({
      payoutId: result.payoutId,
      rewardCount: checked.request.rewardIds.length,
      amountPhp: checked.request.amountPhp,
    });
  } catch (error) {
    logAdminFailure("[admin/referrals] payout not recorded", error);
    return adminAnswer(
      { error: "The payout couldn't be confirmed. Reload to check whether it was recorded before trying again." },
      500,
    );
  }
}
