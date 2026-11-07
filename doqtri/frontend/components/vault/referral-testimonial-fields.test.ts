import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { payoutDraft } from "@/components/vault/referral-payout-client";
import type { TestimonialSlot } from "@/components/vault/referral-testimonial-client";
import { PayoutForm } from "@/components/vault/referral-payout-dialog";

/*
 * The questionnaire's feedback fields as they render (WP-4.6, DOQ-28, D-113), to
 * static markup, since the unit tests run in Node without a DOM. Typing and
 * saving are covered by e2e/referral-testimonials.spec.ts.
 */

function render(testimonial?: TestimonialSlot, canEdit = true) {
  const html = renderToStaticMarkup(
    createElement(PayoutForm, {
      initial: { ...payoutDraft(null), name: "Payee Name" },
      canEdit,
      testimonial,
      saving: false,
      onSavingChange: () => {},
      onClose: () => {},
      onSaved: () => {},
    }),
  );
  return { html, text: html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&") };
}

const tag = (html: string, testId: string) => new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";
/** The attribute itself, not a class that mentions it. */
const has = (element: string, name: string) => new RegExp(`\\s${name}(="[^"]*")?[\\s/>]`).test(element);

describe("while the feedback route doesn't answer (the switch off, or not for this user)", () => {
  it.each([
    ["no slot at all", undefined],
    ["a hidden slot", { kind: "hidden" } as const],
  ])("draws no feedback field, box or note with %s", (_label, slot) => {
    const { html, text } = render(slot);
    expect(html).not.toContain("testimonial-");
    expect(text).not.toContain("feedback");
    expect(text).not.toContain("publicly");
  });
});

describe("with the feedback route answering", () => {
  const ready = (testimonial: TestimonialSlot & { kind: "ready" }) => render(testimonial);

  it("offers optional feedback with the placeholder, and a separate box, unticked", () => {
    const { html, text } = ready({ kind: "ready", testimonial: null, canEdit: true });
    const feedback = tag(html, "testimonial-feedback");
    expect(feedback).toContain('placeholder="I used Doqtri to map my ideas!"');
    expect(feedback).not.toMatch(/\srequired/);
    expect(text).toContain("Feedback (optional)");
    expect(text).toContain("0/500 characters");
    const consent = tag(html, "testimonial-consent");
    expect(consent).toContain('type="checkbox"');
    expect(has(consent, "checked")).toBe(false);
    expect(text).toContain("Doqtri may show my feedback and name publicly.");
  });

  it("says the reward doesn't depend on it, whose name shows, and how to take it down", () => {
    const { text } = ready({ kind: "ready", testimonial: null, canEdit: true });
    expect(text).toContain("your reward never depends on it");
    expect(text).toContain("The name shown is the name in this form.");
    expect(text).toContain("Untick this, or delete your account, and it comes off the site.");
    expect(text).toContain("shown publicly only if you tick the box above and an admin approves them");
  });

  it("labels and describes both fields", () => {
    const { html } = ready({ kind: "ready", testimonial: null, canEdit: true });
    for (const testId of ["testimonial-feedback", "testimonial-consent"]) {
      const element = tag(html, testId);
      const id = /\sid="([^"]+)"/.exec(element)![1];
      expect(html).toContain(`for="${id}"`);
      for (const described of /aria-describedby="([^"]+)"/.exec(element)![1].split(" ")) {
        expect(html).toContain(`id="${described}"`);
      }
    }
  });

  it("opens on what's saved, with where it stands", () => {
    const { html, text } = ready({
      kind: "ready",
      testimonial: { feedback: "Mapped my ideas", consent: true, status: "approved" },
      canEdit: true,
    });
    expect(html).toMatch(/data-testid="testimonial-feedback"[^>]*>Mapped my ideas<\/textarea>|>Mapped my ideas<\/textarea>/);
    expect(has(tag(html, "testimonial-consent"), "checked")).toBe(true);
    expect(text).toContain("Shown on Doqtri's home page.");
  });

  it("without an eligible referral: the words are read-only, the box can still be unticked, and Save is there", () => {
    const { html } = render(
      { kind: "ready", testimonial: { feedback: "Words", consent: true, status: "approved" }, canEdit: false },
      false,
    );
    expect(has(tag(html, "testimonial-feedback"), "readOnly")).toBe(true);
    expect(has(tag(html, "testimonial-consent"), "disabled")).toBe(false);
    expect(html).toContain('data-testid="payout-save"');
  });

  it("without an eligible referral and not opted in, the box can't be ticked", () => {
    const { html } = render(
      { kind: "ready", testimonial: { feedback: "Words", consent: false, status: "private" }, canEdit: false },
      false,
    );
    expect(has(tag(html, "testimonial-consent"), "disabled")).toBe(true);
    expect(html).not.toContain('data-testid="payout-save"');
  });

  it("says so, and still lets the details be saved, when the feedback couldn't be loaded", () => {
    const { html, text } = render({ kind: "unavailable" });
    expect(text).toContain("Your feedback couldn't be loaded");
    expect(html).not.toContain('data-testid="testimonial-feedback"');
    expect(html).toContain('data-testid="payout-save"');
  });
});
