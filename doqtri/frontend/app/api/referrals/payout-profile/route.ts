import { legalPagesLive } from "@/lib/legal";
import { payoutSummary, validatePayoutProfile } from "@/lib/referral-payout";
import { hasEligibleReferral, PayoutStoreError, readPayoutProfile, savePayoutProfile } from "@/lib/referral-payout-profiles";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };

/** Far more than the longest valid form, in bytes. */
const MAX_BODY_BYTES = 8 * 1024;

const NOT_ELIGIBLE = "Payout details open once you have an eligible referral.";
const TOO_LARGE = "That's more than a payout form can hold.";

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
  if (!legalPagesLive()) return answer({ error: "Not found" }, 404);

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
  if (!legalPagesLive()) return answer({ error: "Not found" }, 404);

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return answer({ error: "Sign in to continue." }, 401);
  // Too big to be a form, by its own account: refused before anything is read.
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return answer({ error: TOO_LARGE }, 413);

  try {
    // Service role from here on: user.id comes from the verified session above.
    const admin = createSupabaseAdminClient();
    if (!(await hasEligibleReferral(admin, user.id, NETWORK))) return answer({ error: NOT_ELIGIBLE }, 403);

    // A missing or wrong Content-Length can't get more than the cap read either.
    const text = await readBounded(request, MAX_BODY_BYTES);
    if (text === null) return answer({ error: TOO_LARGE }, 413);
    const body = parseBody(text);
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

/**
 * The body as text, or null once it passes `max` bytes, whatever Content-Length
 * said: reading stops there, and the rest is never taken in.
 */
async function readBounded(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Undefined for what can't be a form. A parser's error can quote the text, so it goes no further. */
function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
