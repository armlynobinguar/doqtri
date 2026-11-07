/**
 * Referral testimonials' reads and writes (server-only, WP-4.6, DOQ-28, D-113),
 * over backend/migrations/20261107140000_referral_testimonials.sql. The rules
 * are in lib/referral-testimonial.ts.
 *
 * Feedback is personal: it is never logged, and a failure carries
 * TestimonialStoreError's fixed text and the database's error code, never its
 * message, which could quote a row.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { connection } from "next/server";
import { referralDashboardLive } from "@/lib/referral-dashboard";
import {
  publicTestimonials,
  testimonialReviewRow,
  testimonialStatus,
  type PublicTestimonial,
  type Testimonial,
  type TestimonialInput,
  type TestimonialReviewRecord,
  type TestimonialReviewRequest,
  type TestimonialReviewRow,
  type TestimonialStateRecord,
} from "@/lib/referral-testimonial";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

const TABLE = "referral_testimonials";
/** The user's own columns: no approver, no dates. */
const OWN_COLUMNS = "feedback, consent, approved_at, rejected_at";

/** PostgREST returns at most 1,000 rows a request. */
const READ_SIZE = 1000;

export class TestimonialStoreError extends Error {
  constructor(
    what: string,
    readonly code: string,
  ) {
    super(`${what} (${code})`);
    this.name = "TestimonialStoreError";
  }
}

function storeError(what: string, error: { code?: string }): TestimonialStoreError {
  return new TestimonialStoreError(what, /^[A-Za-z0-9]{1,10}$/.test(error.code ?? "") ? error.code! : "unknown");
}

/** The label and the database's error code, and nothing else. */
export function logTestimonialFailure(label: string, error: unknown): void {
  console.error(label, error instanceof TestimonialStoreError ? error.code : "unexpected");
}

type OwnRow = TestimonialStateRecord & { feedback: string };

function ownTestimonial(row: OwnRow): Testimonial {
  return { feedback: row.feedback, consent: row.consent, status: testimonialStatus(row) };
}

/** The user's testimonial, or null. `client` is the user's session, where RLS holds, or the service role. */
export async function readOwnTestimonial(
  client: Pick<SupabaseClient, "from">,
  userId: string,
): Promise<Testimonial | null> {
  const { data, error } = await client.from(TABLE).select(OWN_COLUMNS).eq("user_id", userId).maybeSingle();
  if (error) throw storeError("Reading feedback failed", error);
  return data ? ownTestimonial(data as OwnRow) : null;
}

/**
 * Saves what the questionnaire sent, with the service role: `userId` must come
 * from the verified session. No feedback deletes the row. Otherwise only the
 * text and consent are written; the database sets the rest, and clears an
 * approval when the text changes or consent is withdrawn (AC 5).
 */
export async function saveTestimonial(
  admin: Pick<SupabaseClient, "from">,
  userId: string,
  input: TestimonialInput,
): Promise<Testimonial | null> {
  if (input.feedback === null) {
    const { error } = await admin.from(TABLE).delete().eq("user_id", userId);
    if (error) throw storeError("Deleting feedback failed", error);
    return null;
  }
  const { data, error } = await admin
    .from(TABLE)
    .upsert({ user_id: userId, feedback: input.feedback, consent: input.consent }, { onConflict: "user_id" })
    .select(OWN_COLUMNS)
    .single();
  if (error || !data) throw storeError("Saving feedback failed", error ?? {});
  return ownTestimonial(data as OwnRow);
}

/** The approved, consented testimonials, as the landing page gets them: name and text only. */
export async function loadPublicTestimonials(
  admin: Pick<SupabaseClient, "rpc">,
  signal?: AbortSignal,
): Promise<PublicTestimonial[]> {
  const query = admin.rpc("referral_testimonials_public");
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  if (error) throw storeError("Reading testimonials failed", error);
  return publicTestimonials(data);
}

/** How long the landing page waits for testimonials before showing none. */
export const LANDING_TESTIMONIALS_TIMEOUT_MS = 2000;

/**
 * The landing page's testimonials: none at all until the legal pages go live,
 * without asking the database, so the page stays prerendered as it was. Once
 * live, read on every request and never cached, so an approval, a rejection,
 * an edit, a withdrawal or a deleted account shows on the next page load
 * (AC 4). The page streams this in under its own Suspense boundary, so nothing
 * else waits on it. A failure, or no answer within the timeout, shows none and
 * logs only a label and a code.
 */
export async function landingTestimonials(
  timeoutMs: number = LANDING_TESTIMONIALS_TIMEOUT_MS,
): Promise<PublicTestimonial[]> {
  if (!referralDashboardLive()) return [];
  await connection();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([loadPublicTestimonials(createSupabaseAdminClient(), controller.signal), timedOut]);
    if (result === "timeout") {
      console.error("[testimonials] landing page read timed out");
      return [];
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) console.error("[testimonials] landing page read timed out");
    else logTestimonialFailure("[testimonials] landing page read failed", error);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Every testimonial, for the admin panel, waiting for review first. */
export async function loadTestimonialsForReview(admin: Pick<SupabaseClient, "rpc">): Promise<TestimonialReviewRow[]> {
  const rows: TestimonialReviewRow[] = [];
  for (let from = 0; ; from += READ_SIZE) {
    const { data, error } = await admin.rpc("referral_testimonials_for_review").range(from, from + READ_SIZE - 1);
    if (error) throw storeError("Reading testimonials failed", error);
    const page = (data ?? []) as TestimonialReviewRecord[];
    rows.push(...page.map(testimonialReviewRow));
    if (page.length < READ_SIZE) return rows;
  }
}

export type TestimonialReviewResult = "approved" | "rejected" | "changed" | "private" | "no_name" | "admin_gone";

const RESULTS = new Set<TestimonialReviewResult>(["approved", "rejected", "changed", "private", "no_name", "admin_gone"]);

/** An admin's decision on the version they read. `adminId` comes from the route's verified admin session. */
export async function reviewTestimonial(
  admin: Pick<SupabaseClient, "rpc">,
  request: TestimonialReviewRequest,
  adminId: string,
): Promise<TestimonialReviewResult> {
  const { data, error } = await admin.rpc("referral_testimonial_review", {
    p_user_id: request.userId,
    p_version: request.version,
    p_approve: request.decision === "approve",
    p_admin: adminId,
  });
  if (error) throw storeError("Reviewing a testimonial failed", error);
  if (!RESULTS.has(data as TestimonialReviewResult)) throw new TestimonialStoreError("Reviewing a testimonial failed", "unknown");
  return data as TestimonialReviewResult;
}
