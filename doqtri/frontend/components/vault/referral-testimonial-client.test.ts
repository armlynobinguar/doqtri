import { afterEach, describe, expect, it, vi } from "vitest";
import { payoutDraft } from "@/components/vault/referral-payout-client";
import {
  createQuestionnaireSaver,
  feedbackInput,
  readTestimonial,
  testimonialChanged,
  testimonialDraft,
  testimonialStatusNote,
  type QuestionnaireRequest,
} from "@/components/vault/referral-testimonial-client";
import type { Testimonial } from "@/lib/referral-testimonial";

/*
 * The questionnaire's feedback logic (WP-4.6, DOQ-28, D-113), apart from React:
 * the questionnaire saves without feedback (AC 1), unchanged feedback isn't
 * sent, both parts are checked before either is sent, and a failed feedback save
 * after saved details says so.
 */

const G = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const DETAILS = { ...payoutDraft(null), name: "Payee Name", method: "xlm" as const, address: G };
const SUMMARY = { label: "XLM", last4: "OX2H", memoType: null };
const APPROVED: Testimonial = { feedback: "Words", consent: true, status: "approved" };

function saverWith() {
  const writeDetails = vi.fn(async () => ({ summary: SUMMARY }));
  const writeFeedback = vi.fn(async (input: { feedback: string | null; consent: boolean }) => ({
    testimonial: input.feedback ? { feedback: input.feedback, consent: input.consent, status: "pending" as const } : null,
  }));
  return { writeDetails, writeFeedback, saver: createQuestionnaireSaver(writeDetails, writeFeedback) };
}

const request = (testimonial: QuestionnaireRequest["testimonial"], canEditDetails = true): QuestionnaireRequest => ({
  draft: DETAILS,
  canEditDetails,
  testimonial,
});

afterEach(() => vi.unstubAllGlobals());

describe("createQuestionnaireSaver", () => {
  it("saves the details with no feedback at all, sending nothing for feedback (AC 1)", async () => {
    const { saver, writeDetails, writeFeedback } = saverWith();
    const outcome = await saver.save(request({ saved: null, draft: { feedback: "", consent: false } }));
    expect(outcome).toEqual({ kind: "saved", summary: SUMMARY, testimonialSaved: false });
    expect(writeDetails).toHaveBeenCalledTimes(1);
    expect(writeFeedback).not.toHaveBeenCalled();
  });

  it("saves the details as before when the feedback fields aren't shown", async () => {
    const { saver, writeFeedback } = saverWith();
    expect(await saver.save(request(null))).toEqual({ kind: "saved", summary: SUMMARY, testimonialSaved: false });
    expect(writeFeedback).not.toHaveBeenCalled();
  });

  it("saves changed feedback after the details", async () => {
    const { saver, writeDetails, writeFeedback } = saverWith();
    const outcome = await saver.save(request({ saved: null, draft: { feedback: " Mapped it ", consent: true } }));
    expect(outcome).toEqual({ kind: "saved", summary: SUMMARY, testimonialSaved: true });
    expect(writeFeedback).toHaveBeenCalledWith({ feedback: "Mapped it", consent: true });
    expect(writeDetails.mock.invocationCallOrder[0]).toBeLessThan(writeFeedback.mock.invocationCallOrder[0]);
  });

  it("doesn't resend unchanged feedback, so an approval isn't touched", async () => {
    const { saver, writeFeedback } = saverWith();
    await saver.save(request({ saved: APPROVED, draft: { feedback: "Words ", consent: true } }));
    expect(writeFeedback).not.toHaveBeenCalled();
  });

  it("checks both before sending either", async () => {
    const { saver, writeDetails, writeFeedback } = saverWith();
    const outcome = await saver.save({
      draft: { ...DETAILS, name: "" },
      canEditDetails: true,
      testimonial: { saved: null, draft: { feedback: "a\tb", consent: false } },
    });
    expect(outcome).toEqual({
      kind: "invalid",
      errors: { name: "Enter your name.", feedback: "Remove the line breaks or special characters." },
    });
    expect(writeDetails).not.toHaveBeenCalled();
    expect(writeFeedback).not.toHaveBeenCalled();
  });

  it("says the details were saved when the feedback wasn't", async () => {
    const writeFeedback = vi.fn(async () => ({ message: "Your feedback couldn't be saved.", fields: {} }));
    const saver = createQuestionnaireSaver(async () => ({ summary: SUMMARY }), writeFeedback);
    expect(await saver.save(request({ saved: null, draft: { feedback: "Words", consent: false } }))).toEqual({
      kind: "partial",
      summary: SUMMARY,
      message: "Your payout details were saved. Your feedback couldn't be saved.",
      errors: {},
    });
  });

  it("sends no feedback when the details are refused", async () => {
    const writeFeedback = vi.fn();
    const saver = createQuestionnaireSaver(async () => ({ message: "Check the highlighted details.", fields: { name: "x" } }), writeFeedback);
    expect((await saver.save(request({ saved: null, draft: { feedback: "Words", consent: true } }))).kind).toBe("refused");
    expect(writeFeedback).not.toHaveBeenCalled();
  });

  it("without an eligible referral, withdraws consent alone, without sending the details", async () => {
    const { saver, writeDetails, writeFeedback } = saverWith();
    const outcome = await saver.save(request({ saved: APPROVED, draft: { feedback: "Words", consent: false } }, false));
    expect(outcome).toEqual({ kind: "saved", summary: null, testimonialSaved: true });
    expect(writeDetails).not.toHaveBeenCalled();
    expect(writeFeedback).toHaveBeenCalledWith({ feedback: "Words", consent: false });
  });

  it("is one save at a time", async () => {
    let release!: () => void;
    const saver = createQuestionnaireSaver(
      () => new Promise((resolve) => (release = () => resolve({ summary: SUMMARY }))),
      async () => ({ testimonial: null }),
    );
    const first = saver.save(request(null));
    expect(await saver.save(request(null))).toEqual({ kind: "busy" });
    release();
    expect((await first).kind).toBe("saved");
  });
});

describe("the fields' helpers", () => {
  it("open unticked, or as the user left them", () => {
    expect(testimonialDraft(null)).toEqual({ feedback: "", consent: false });
    expect(testimonialDraft(APPROVED)).toEqual({ feedback: "Words", consent: true });
  });

  it("turn line breaks into spaces as they're typed or pasted", () => {
    expect(feedbackInput("one\ntwo\r\nthree\rfour")).toBe("one two three four");
  });

  it("know when something changed", () => {
    expect(testimonialChanged(null, { feedback: " ", consent: false })).toBe(false);
    expect(testimonialChanged(null, { feedback: "", consent: true })).toBe(true);
    expect(testimonialChanged(APPROVED, { feedback: "Words", consent: true })).toBe(false);
    expect(testimonialChanged(APPROVED, { feedback: "Words!", consent: true })).toBe(true);
    expect(testimonialChanged(APPROVED, { feedback: "Words", consent: false })).toBe(true);
  });

  it("say where a shared testimonial stands, and that an edit is reviewed again", () => {
    expect(testimonialStatusNote(APPROVED, { feedback: "Words", consent: true })).toBe("Shown on Doqtri's home page.");
    expect(testimonialStatusNote({ ...APPROVED, status: "pending" }, { feedback: "Words", consent: true })).toBe(
      "Waiting for review before it's shown.",
    );
    expect(testimonialStatusNote({ ...APPROVED, status: "rejected" }, { feedback: "Words", consent: true })).toContain(
      "Not shown on the site.",
    );
    expect(testimonialStatusNote(APPROVED, { feedback: "Edited", consent: true })).toBe(
      "Saving sends your feedback for review again.",
    );
    expect(testimonialStatusNote(APPROVED, { feedback: "Words", consent: false })).toBeNull();
    expect(testimonialStatusNote({ feedback: "Words", consent: false, status: "private" }, { feedback: "Words", consent: false })).toBeNull();
  });
});

describe("readTestimonial", () => {
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it("hides the fields while the route is off (404) or not for this user (403)", async () => {
    respond(404, { error: "Not found" });
    expect(await readTestimonial()).toEqual({ kind: "hidden" });
    respond(403, { error: "Feedback opens once you have an eligible referral." });
    expect(await readTestimonial()).toEqual({ kind: "hidden" });
  });

  it("shows them with what's saved, never from a cache", async () => {
    respond(200, { testimonial: APPROVED, canEdit: true });
    expect(await readTestimonial()).toEqual({ kind: "ready", testimonial: APPROVED, canEdit: true });
    expect(vi.mocked(fetch).mock.calls[0][1]).toEqual({ cache: "no-store" });
  });

  it("says so when they can't be loaded", async () => {
    respond(500, { error: "Your feedback couldn't be loaded." });
    expect(await readTestimonial()).toEqual({ kind: "unavailable" });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    expect(await readTestimonial()).toEqual({ kind: "unavailable" });
  });
});
