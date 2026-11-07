import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReferralTestimonials, TestimonialRow } from "@/components/admin/referral-testimonials";
import {
  canDecide,
  reviewRequest,
  reviewedMessage,
  sendReview,
} from "@/components/admin/referral-testimonials-client";
import type { TestimonialReviewRow } from "@/lib/referral-testimonial";

/*
 * The admin panel's testimonial review (WP-4.6, DOQ-28, D-113): what each row
 * offers, rendered to static markup, and what a decision sends. Clicking through
 * is covered by e2e/referral-testimonials.spec.ts.
 */

const USER = "00000000-0000-4000-8000-0000000000b2";
const VERSION = "2026-11-07T01:02:03.456789+00:00";
const row = (status: TestimonialReviewRow["status"], name: string | null = "Payee Name"): TestimonialReviewRow => ({
  userId: USER,
  name,
  feedback: "Mapped my whole roadmap.",
  status,
  version: VERSION,
});

const renderRow = (r: TestimonialReviewRow) =>
  renderToStaticMarkup(createElement(TestimonialRow, { row: r, busy: null, onDecide: () => {} }));
const button = (html: string, testId: string) => new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0];
/** The disabled attribute itself, not a class that mentions it. */
const disabled = (element: string | undefined) => /\sdisabled(="[^"]*")?[\s>]/.test(element ?? "");

afterEach(() => vi.unstubAllGlobals());

describe("a row", () => {
  it("pending: name, text, state, and both decisions", () => {
    const html = renderRow(row("pending"));
    expect(html).toContain("Payee Name");
    expect(html).toContain("Mapped my whole roadmap.");
    expect(html).toContain("Pending review");
    expect(disabled(button(html, "testimonial-approve"))).toBe(false);
    expect(disabled(button(html, "testimonial-reject"))).toBe(false);
  });

  it("approved can be rejected, rejected can be approved", () => {
    expect(disabled(button(renderRow(row("approved")), "testimonial-approve"))).toBe(true);
    expect(disabled(button(renderRow(row("approved")), "testimonial-reject"))).toBe(false);
    expect(disabled(button(renderRow(row("rejected")), "testimonial-reject"))).toBe(true);
    expect(disabled(button(renderRow(row("rejected")), "testimonial-approve"))).toBe(false);
  });

  it("private: labelled as not publishable, with no decision to make", () => {
    const html = renderRow(row("private"));
    expect(html).toContain("Private");
    expect(html).toContain("can&#x27;t be published");
    expect(button(html, "testimonial-approve")).toBeUndefined();
    expect(button(html, "testimonial-reject")).toBeUndefined();
  });

  it("without a questionnaire name: can't be approved, says why, and can still be rejected", () => {
    const html = renderRow(row("pending", null));
    expect(html).toContain("No name saved");
    expect(html).toContain("so it can&#x27;t be approved");
    expect(disabled(button(html, "testimonial-approve"))).toBe(true);
    expect(disabled(button(html, "testimonial-reject"))).toBe(false);
  });
});

describe("the section", () => {
  it("says when nothing has come in", () => {
    const html = renderToStaticMarkup(createElement(ReferralTestimonials, { initialRows: [] }));
    expect(html).toContain("No feedback yet.");
    expect(html).toContain("0 waiting for review");
  });

  it("says when the list couldn't be loaded, with a retry", () => {
    const html = renderToStaticMarkup(createElement(ReferralTestimonials, { initialRows: null }));
    expect(html).toContain("The testimonials couldn&#x27;t be loaded.");
    expect(html).toContain('data-testid="testimonials-retry"');
  });
});

describe("a decision", () => {
  it("sends the version the row showed", () => {
    expect(reviewRequest(row("pending"), "approve")).toEqual({ userId: USER, version: VERSION, decision: "approve" });
  });

  it("is never made on private feedback, nor repeated", () => {
    expect(reviewRequest(row("private"), "approve")).toBeNull();
    expect(reviewRequest(row("private"), "reject")).toBeNull();
    expect(canDecide(row("approved"), "approve")).toBe(false);
    expect(canDecide(row("rejected"), "reject")).toBe(false);
  });

  it("is never an approval without a name to see", () => {
    expect(reviewRequest(row("pending", null), "approve")).toBeNull();
    expect(reviewRequest(row("rejected", null), "approve")).toBeNull();
    expect(reviewRequest(row("pending", null), "reject")).toEqual({ userId: USER, version: VERSION, decision: "reject" });
  });

  it("posts to the admin route, never cached, and takes the server's words on a refusal", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "This feedback changed." }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendReview({ userId: USER, version: VERSION, decision: "reject" })).toEqual({
      ok: false,
      message: "This feedback changed.",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/referrals/testimonials", {
      cache: "no-store",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: USER, version: VERSION, decision: "reject" }),
    });
  });

  it("is described afterwards", () => {
    expect(reviewedMessage(row("pending"), "approved")).toContain("Approved Payee Name's testimonial.");
    expect(reviewedMessage(row("approved"), "rejected")).toContain("isn't shown on the site");
  });
});
