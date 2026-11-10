import { adminAnswer, adminNotFound, adminUserId, logAdminFailure } from "@/lib/admin-route";
import {
  alreadyPaidMessage,
  busyMessage,
  checkMarkPaid,
  checkPayoutRequest,
  isUuid,
  type PayoutRequest,
} from "@/lib/referral-payouts";
import {
  loadPayoutQueue,
  loadPayoutReferrals,
  markRewardsPaid,
  readConflict,
  readJsonBody,
  releasePayout,
  startPayout,
  type PayoutRefusal,
} from "@/lib/referral-payouts-store";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** A thousand reward ids and the rest, with room to spare. */
const MAX_BODY_BYTES = 64 * 1024;

type Step = "start" | "record";

const STALE = "These rewards changed since the page loaded: some were voided, moved or are no longer eligible.";

/** Fixed words for each refusal, by step. Stale and busy get who and when, from the database. */
const REFUSED: Record<Exclude<PayoutRefusal, "stale" | "busy">, Record<Step, string>> = {
  no_details: {
    start: "This referrer hasn't added payout details yet, so there is nowhere to pay.",
    record: "This referrer has no payout details any more. Nothing was recorded.",
  },
  details_changed: {
    start: "The payout details changed since the page loaded. Nothing is held: check the new details and start again.",
    record:
      "The payout details changed after you started. Nothing was recorded. If you already sent money to the old details, reconcile with the referrer.",
  },
  admin_gone: {
    start: "Your admin account no longer exists, so nothing was started. Sign in again.",
    record: "Your admin account no longer exists, so nothing was recorded. Sign in again.",
  },
  no_claim: {
    start: "Reload the page and try again.",
    record:
      "You no longer hold this payout: it was released or its 2 hours ran out. Nothing was recorded. Start it again, and if you already sent the money, record it straight away.",
  },
  invalid: {
    start: "Reload the page and try again.",
    record: "Check the reference: up to 100 characters, with no line breaks or special characters.",
  },
};

/**
 * The payout queue (WP-4.6, DOQ-26), or with `?referrer=<id>` everyone that
 * referrer referred, in full, for review. Admins only; a 404 for anyone else.
 * Holds payout details in full, so never cached.
 */
export async function GET(request: Request) {
  const viewer = await adminUserId();
  if (!viewer) return adminNotFound();

  const referrer = new URL(request.url).searchParams.get("referrer");
  if (referrer !== null && !isUuid(referrer)) return adminNotFound();

  try {
    const admin = createSupabaseAdminClient();
    if (referrer) return adminAnswer({ referrals: await loadPayoutReferrals(admin, referrer, NETWORK) });
    return adminAnswer({ rows: await loadPayoutQueue(admin, viewer) });
  } catch (error) {
    logAdminFailure("[admin/referrals] payouts not loaded", error);
    return adminAnswer({ error: "The payout queue couldn't be loaded." }, 500);
  }
}

/**
 * Paying a referrer, in two steps, since the money leaves by hand in between.
 * Nothing is sent from here.
 *
 *   start    holds the payout for this admin for 2 hours, for exactly the
 *            rewards, total and details version they saw, and answers the
 *            details as they are now. Only then does the admin send the money.
 *   record   records it: needs the admin's live hold on the same rewards, total
 *            and version, and clears it.
 *   release  gives the hold up without paying.
 *
 * A refusal says who already paid, or who is paying, so an admin who has sent
 * money knows to reconcile rather than pay again.
 */
export async function POST(request: Request) {
  const adminId = await adminUserId();
  if (!adminId) return adminNotFound();

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return body.reason === "too_large"
      ? adminAnswer({ error: "That's more than a payout can hold." }, 413)
      : adminAnswer({ error: "Reload the page and try again." }, 400);
  }
  const action = (body.value as { action?: unknown } | null)?.action;

  try {
    const admin = createSupabaseAdminClient();
    if (action === "release") {
      const referrerId = (body.value as { referrerId?: unknown }).referrerId;
      if (!isUuid(referrerId)) return adminAnswer({ error: "Reload the page and try again." }, 400);
      if (!(await releasePayout(admin, referrerId, adminId))) {
        return adminAnswer(
          { error: "You don't hold this payout any more: it was released or its 2 hours ran out.", refusal: "no_claim" },
          409,
        );
      }
      return adminAnswer({ released: true });
    }

    if (action === "start") {
      const checked = checkPayoutRequest(body.value);
      if (!checked.ok) return adminAnswer({ error: checked.error }, 400);
      const result = await startPayout(admin, checked.request, adminId);
      if (!result.ok) return refused(admin, result.refusal, checked.request, "start");
      return adminAnswer({
        started: { details: result.details, claimedAt: result.claimedAt, expiresAt: result.expiresAt },
        rewardCount: checked.request.rewardIds.length,
        amountPhp: checked.request.amountPhp,
      });
    }

    if (action === "record") {
      const checked = checkMarkPaid(body.value);
      if (!checked.ok) return adminAnswer({ error: checked.error }, 400);
      const result = await markRewardsPaid(admin, checked.request, adminId);
      if (!result.ok) return refused(admin, result.refusal, checked.request, "record");
      return adminAnswer({
        payoutId: result.payoutId,
        rewardCount: checked.request.rewardIds.length,
        amountPhp: checked.request.amountPhp,
      });
    }

    return adminAnswer({ error: "Reload the page and try again." }, 400);
  } catch (error) {
    logAdminFailure(`[admin/referrals] payout ${action === "record" ? "not recorded" : "not changed"}`, error);
    return adminAnswer(
      {
        error:
          action === "record"
            ? "The payout couldn't be confirmed. Reload to check whether it was recorded before trying again."
            : "The payout couldn't be started or released. Reload and try again.",
      },
      500,
    );
  }
}

/** A refusal's answer. Stale and busy look up who and when; a failed lookup still refuses, in plainer words. */
async function refused(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  refusal: PayoutRefusal,
  request: PayoutRequest,
  step: Step,
): Promise<Response> {
  if (refusal === "stale" || refusal === "busy") {
    const conflict = await readConflict(admin, request.referrerId, request.rewardIds).catch((error: unknown) => {
      logAdminFailure("[admin/referrals] payout conflict not read", error);
      return null;
    });
    if (conflict?.paid.length) return adminAnswer({ error: alreadyPaidMessage(conflict.paid), refusal: "paid" }, 409);
    if (refusal === "busy") {
      const error = conflict?.claim
        ? busyMessage(conflict.claim)
        : "Another admin is paying this referrer. Don't send anything.";
      return adminAnswer({ error, refusal }, 409);
    }
    const nothing = step === "start" ? "Nothing is held." : "Nothing was recorded.";
    return adminAnswer({ error: `${STALE} ${nothing} Reload and check them.`, refusal }, 409);
  }
  return adminAnswer({ error: REFUSED[refusal][step], refusal }, refusal === "invalid" ? 400 : 409);
}
