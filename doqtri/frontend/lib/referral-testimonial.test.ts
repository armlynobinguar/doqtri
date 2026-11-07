import { describe, expect, it } from "vitest";
import {
  LANDING_TESTIMONIALS_MAX,
  TESTIMONIAL_FEEDBACK_MAX,
  checkTestimonialReview,
  publicTestimonials,
  testimonialReviewRow,
  testimonialStatus,
  validateTestimonial,
} from "@/lib/referral-testimonial";

/**
 * Referral testimonials' rules (WP-4.6, DOQ-28, D-113): the feedback validator,
 * which shares the payout name's character rules, where a testimonial stands,
 * and what the landing page and the admin route accept.
 */

const USER = "00000000-0000-4000-8000-000000000003";

describe("validateTestimonial", () => {
  it("takes no feedback at all: it's optional, and saves as none (AC 1)", () => {
    expect(validateTestimonial({})).toEqual({ ok: true, value: { feedback: null, consent: false } });
    expect(validateTestimonial({ feedback: "", consent: false })).toEqual({ ok: true, value: { feedback: null, consent: false } });
    expect(validateTestimonial({ feedback: "   " })).toEqual({ ok: true, value: { feedback: null, consent: false } });
    expect(validateTestimonial(null)).toEqual({ ok: true, value: { feedback: null, consent: false } });
  });

  it("takes feedback, trimmed, with or without consent", () => {
    expect(validateTestimonial({ feedback: "  I used Doqtri to map my ideas!  ", consent: true })).toEqual({
      ok: true,
      value: { feedback: "I used Doqtri to map my ideas!", consent: true },
    });
    expect(validateTestimonial({ feedback: "Just for the team.", consent: false })).toEqual({
      ok: true,
      value: { feedback: "Just for the team.", consent: false },
    });
  });

  it("counts 500 characters as a person does: an emoji is one", () => {
    expect(validateTestimonial({ feedback: "a".repeat(TESTIMONIAL_FEEDBACK_MAX) }).ok).toBe(true);
    // 500 code points, though 999 UTF-16 units.
    expect(validateTestimonial({ feedback: "a" + "\u{1F44D}".repeat(TESTIMONIAL_FEEDBACK_MAX - 1) }).ok).toBe(true);
    expect(validateTestimonial({ feedback: "a" + "\u{1F44D}".repeat(TESTIMONIAL_FEEDBACK_MAX) }).ok).toBe(false);
    expect(validateTestimonial({ feedback: "a".repeat(TESTIMONIAL_FEEDBACK_MAX + 1) })).toEqual({
      ok: false,
      errors: { feedback: "Use 500 characters or fewer." },
    });
  });

  it.each([
    ["a line break", "line one\nline two"],
    ["a tab", "a\tb"],
    ["a zero-width space", "hidden\u200bspace"],
    ["a reordering mark", "abc\u202edef"],
    ["a byte order mark", "ab\ufeffc"],
    ["a line separator", "abc\u2028def"],
    ["a Hangul filler", "abc\u3164"],
    ["a blank Braille pattern", "abc\u2800"],
  ])("refuses %s, as the payout name does", (_label, feedback) => {
    expect(validateTestimonial({ feedback })).toEqual({
      ok: false,
      errors: { feedback: "Remove the line breaks or special characters." },
    });
  });

  it("needs a letter or number in any script, when there is feedback", () => {
    expect(validateTestimonial({ feedback: "!!! ..." })).toEqual({
      ok: false,
      errors: { feedback: "Use at least one letter or number." },
    });
    expect(validateTestimonial({ feedback: "\u041e\u0442\u043b\u0438\u0447\u043d\u043e \u2014 \u4f60\u597d \u{1F44D}" }).ok).toBe(true);
  });

  it("refuses consent with nothing to share rather than dropping it", () => {
    expect(validateTestimonial({ feedback: "", consent: true })).toEqual({
      ok: false,
      errors: { consent: "Write your feedback to share it, or untick this." },
    });
  });

  it("refuses consent that isn't true or false", () => {
    expect(validateTestimonial({ feedback: "Fine", consent: "yes" }).ok).toBe(false);
    expect(validateTestimonial({ feedback: 42 })).toEqual({ ok: false, errors: { feedback: "Enter this as text." } });
  });

  it("keeps only the two fields: a user id or an approval goes no further", () => {
    const result = validateTestimonial({
      feedback: "Mine",
      consent: true,
      user_id: USER,
      approved_at: "2026-11-07T00:00:00Z",
      approved_by: USER,
    });
    expect(result).toEqual({ ok: true, value: { feedback: "Mine", consent: true } });
  });
});

describe("testimonialStatus", () => {
  it("is private without consent, whatever else is set", () => {
    expect(testimonialStatus({ consent: false, approved_at: "2026-11-07T00:00:00Z", rejected_at: null })).toBe("private");
  });
  it("is approved, rejected or pending with consent", () => {
    expect(testimonialStatus({ consent: true, approved_at: "2026-11-07T00:00:00Z", rejected_at: null })).toBe("approved");
    expect(testimonialStatus({ consent: true, approved_at: null, rejected_at: "2026-11-07T00:00:00Z" })).toBe("rejected");
    expect(testimonialStatus({ consent: true, approved_at: null, rejected_at: null })).toBe("pending");
  });
});

describe("publicTestimonials", () => {
  it("copies out name and feedback only, whatever else a row carries (AC 3)", () => {
    const shaped = publicTestimonials([
      {
        name: "Payee Name",
        feedback: "Great for planning.",
        user_id: USER,
        email: "payee@example.com",
        xlm_address: "G" + "A".repeat(55),
        ewallet_account_number: "09171234567",
        approved_at: "2026-11-07T00:00:00Z",
        approved_by: USER,
      },
    ]);
    expect(shaped).toEqual([{ name: "Payee Name", feedback: "Great for planning." }]);
    expect(Object.keys(shaped[0])).toEqual(["name", "feedback"]);
  });

  it("leaves out a row missing either, and anything that isn't a list", () => {
    expect(publicTestimonials([{ name: "", feedback: "x" }, { name: "A", feedback: null }, null, "row"])).toEqual([]);
    expect(publicTestimonials(null)).toEqual([]);
    expect(publicTestimonials({ name: "A", feedback: "B" })).toEqual([]);
  });

  it("keeps the database's order and stops at 12", () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ name: `Referrer ${i}`, feedback: `Words ${i}` }));
    const shaped = publicTestimonials(rows);
    expect(shaped).toHaveLength(LANDING_TESTIMONIALS_MAX);
    expect(shaped.map((t) => t.name)).toEqual(rows.slice(0, 12).map((r) => r.name));
  });
});

describe("the admin side", () => {
  it("shapes a review row with its status and version", () => {
    expect(
      testimonialReviewRow({
        user_id: USER,
        name: null,
        feedback: "Words",
        consent: true,
        approved_at: null,
        rejected_at: null,
        updated_at: "2026-11-07T01:02:03.456789+00:00",
      }),
    ).toEqual({ userId: USER, name: null, feedback: "Words", status: "pending", version: "2026-11-07T01:02:03.456789+00:00" });
  });

  it("accepts a decision on a user and version", () => {
    const version = "2026-11-07T01:02:03.456789+00:00";
    expect(checkTestimonialReview({ userId: USER, version, decision: "approve" })).toEqual({
      ok: true,
      value: { userId: USER, version, decision: "approve" },
    });
    expect(checkTestimonialReview({ userId: USER, version, decision: "reject" }).ok).toBe(true);
  });

  it.each([
    ["no user", { version: "2026-11-07T00:00:00Z", decision: "approve" }],
    ["a user that isn't a uuid", { userId: "nope", version: "2026-11-07T00:00:00Z", decision: "approve" }],
    ["no version", { userId: USER, decision: "approve" }],
    ["a version that isn't a time", { userId: USER, version: "yesterday", decision: "approve" }],
    ["an unknown decision", { userId: USER, version: "2026-11-07T00:00:00Z", decision: "publish" }],
    ["nothing", null],
  ])("refuses %s", (_label, body) => {
    expect(checkTestimonialReview(body)).toEqual({ ok: false, error: "Reload the page and try again." });
  });
});
