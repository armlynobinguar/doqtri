import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPayoutSaver,
  LOAD_FAILED,
  payoutCard,
  payoutDraft,
  readPayoutDetails,
  SAVE_FAILED,
  writePayoutDetails,
  type PayoutDraft,
  type PayoutWritten,
} from "@/components/vault/referral-payout-client";
import type { PayoutProfile } from "@/lib/referral-payout";

/** The payout questionnaire's logic, apart from React (WP-4.6, DOQ-25, D-112). */

const G = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();

const draft = (over: Partial<PayoutDraft> = {}): PayoutDraft => ({
  ...payoutDraft(null),
  name: "A Referrer",
  method: "xlm",
  address: G,
  ...over,
});

/** A write that answers only when told to. */
function heldWrite() {
  let release: (written: PayoutWritten) => void = () => {};
  const write = vi.fn(
    (profile: PayoutProfile) =>
      new Promise<PayoutWritten>((resolve) => {
        void profile;
        release = resolve;
      }),
  );
  return { write, release: (written: PayoutWritten) => release(written) };
}

afterEach(() => vi.unstubAllGlobals());

describe("saving", () => {
  it("sends what the form's check passed, once, however many times it's pressed", async () => {
    const { write, release } = heldWrite();
    const saver = createPayoutSaver(write);
    const onSend = vi.fn();

    const first = saver.save(draft(), onSend);
    expect(saver.saving).toBe(true);
    expect(await saver.save(draft(), onSend)).toEqual({ kind: "busy" });
    expect(await saver.save(draft(), onSend)).toEqual({ kind: "busy" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledTimes(1);

    release({ summary: { label: "XLM", last4: G.slice(-4) } });
    expect(await first).toEqual({ kind: "saved", summary: { label: "XLM", last4: G.slice(-4) } });
    expect(saver.saving).toBe(false);
  });

  it("can save again once the first has answered, even if it failed", async () => {
    const write = vi.fn(async () => {
      throw new Error("offline");
    });
    const saver = createPayoutSaver(write);
    await expect(saver.save(draft())).rejects.toThrow("offline");
    expect(saver.saving).toBe(false);
    await expect(saver.save(draft())).rejects.toThrow("offline");
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("sends nothing the form's own check refuses, and doesn't count as saving", async () => {
    const write = vi.fn();
    const onSend = vi.fn();
    const saver = createPayoutSaver(write);
    expect(await saver.save(draft({ address: "C".padEnd(56, "A") }), onSend)).toMatchObject({
      kind: "invalid",
      errors: { address: expect.stringContaining("passkey") },
    });
    expect(write).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(saver.saving).toBe(false);
  });

  it("sends only the chosen method's fields, trimmed", async () => {
    const write = vi.fn(async (): Promise<PayoutWritten> => ({ summary: { label: "GCash", last4: "4567" } }));
    await createPayoutSaver(write).save(
      draft({
        method: "ewallet",
        address: G,
        memo: "99",
        provider: "GCash",
        accountName: " A Referrer ",
        accountNumber: "09171234567",
      }),
    );
    expect(write).toHaveBeenCalledWith({
      method: "ewallet",
      name: "A Referrer",
      provider: "GCash",
      accountName: "A Referrer",
      accountNumber: "09171234567",
      details: null,
    });
  });

  it("passes on the server's refusal and the fields it names", async () => {
    const write = vi.fn(
      async (): Promise<PayoutWritten> => ({ message: "Check the highlighted details.", fields: { address: "Bad." } }),
    );
    expect(await createPayoutSaver(write).save(draft())).toEqual({
      kind: "refused",
      message: "Check the highlighted details.",
      errors: { address: "Bad." },
    });
  });
});

describe("the fields as they open", () => {
  it("are empty with nothing saved: the user's own testnet wallet isn't filled in", () => {
    expect(payoutDraft(null)).toEqual({
      name: "",
      method: "",
      address: "",
      memo: "",
      memoType: "text",
      provider: "",
      accountName: "",
      accountNumber: "",
      details: "",
    });
  });

  it("are what's saved, for XLM", () => {
    expect(payoutDraft({ method: "xlm", name: "A Referrer", address: G, memo: null, memoType: null })).toMatchObject({
      method: "xlm",
      name: "A Referrer",
      address: G,
      memo: "",
      memoType: "text",
      accountNumber: "",
    });
    expect(payoutDraft({ method: "xlm", name: "A Referrer", address: G, memo: "42", memoType: "id" })).toMatchObject({
      memo: "42",
      memoType: "id",
    });
  });

  it("are what's saved, for an e-wallet", () => {
    expect(
      payoutDraft({
        method: "ewallet",
        name: "A Referrer",
        provider: "Maya",
        accountName: "Holder",
        accountNumber: "09171234567",
        details: "Main",
      }),
    ).toMatchObject({ method: "ewallet", provider: "Maya", accountNumber: "09171234567", details: "Main", address: "" });
  });
});

describe("the dashboard's card", () => {
  const SAVED = { label: "XLM", last4: "WXYZ" };

  it("asks for details for an unpaid reward with none saved", () => {
    expect(payoutCard({ canEdit: true, summary: null }, true, null)).toEqual({ kind: "needed" });
  });

  it("shows what's saved instead, with Edit for someone who can still change it", () => {
    expect(payoutCard({ canEdit: true, summary: SAVED }, false, null)).toEqual({
      kind: "saved",
      summary: SAVED,
      canEdit: true,
    });
  });

  it("a save just made wins over the page's older data", () => {
    expect(payoutCard({ canEdit: true, summary: null }, true, SAVED)).toEqual({
      kind: "saved",
      summary: SAVED,
      canEdit: true,
    });
    expect(payoutCard({ canEdit: true, summary: { label: "GCash", last4: "1111" } }, false, SAVED)).toMatchObject({
      summary: SAVED,
    });
  });

  it("lets an owner who no longer qualifies see what's stored, read-only", () => {
    expect(payoutCard({ canEdit: false, summary: SAVED }, false, null)).toEqual({
      kind: "saved",
      summary: SAVED,
      canEdit: false,
    });
  });

  it("offers to add details to someone eligible with nothing owed right now", () => {
    expect(payoutCard({ canEdit: true, summary: null }, false, null)).toEqual({ kind: "empty" });
  });

  it("says only that the details couldn't be loaded when that's so, rather than ask for them", () => {
    expect(payoutCard({ canEdit: true, summary: null, unavailable: true }, false, null)).toEqual({ kind: "unavailable" });
    expect(payoutCard({ canEdit: false, summary: null, unavailable: true }, false, null)).toEqual({ kind: "unavailable" });
    // A save made since wins: then it's known.
    expect(payoutCard({ canEdit: true, summary: null, unavailable: true }, false, SAVED)).toMatchObject({ kind: "saved" });
  });

  it("is nothing for someone with neither details nor an eligible referral", () => {
    expect(payoutCard({ canEdit: false, summary: null }, false, null)).toBeNull();
  });
});

describe("talking to the route", () => {
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

  it("reads the details, never from a cache", async () => {
    const fetch = respond(200, { profile: null, canEdit: true });
    vi.stubGlobal("fetch", fetch);
    expect(await readPayoutDetails()).toEqual({ profile: null, canEdit: true });
    expect(fetch).toHaveBeenCalledWith("/api/referrals/payout-profile", { cache: "no-store" });
  });

  it("passes on the route's own words when it refuses", async () => {
    vi.stubGlobal("fetch", respond(403, { error: "Payout details open once you have an eligible referral." }));
    expect(await readPayoutDetails()).toEqual({ message: "Payout details open once you have an eligible referral." });
  });

  it("says its own for a dropped connection or an answer that isn't one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect(await readPayoutDetails()).toEqual({ message: LOAD_FAILED });
    vi.stubGlobal("fetch", respond(200, { something: "else" }));
    expect(await readPayoutDetails()).toEqual({ message: LOAD_FAILED });
  });

  it("writes with PUT and JSON, and takes the summary back", async () => {
    const fetch = respond(200, { summary: { label: "XLM", last4: "WXYZ" } });
    vi.stubGlobal("fetch", fetch);
    const profile: PayoutProfile = { method: "xlm", name: "A Referrer", address: G, memo: null, memoType: null };
    expect(await writePayoutDetails(profile)).toEqual({ summary: { label: "XLM", last4: "WXYZ" } });
    expect(fetch).toHaveBeenCalledWith("/api/referrals/payout-profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });
  });

  it("passes on a refusal's fields, and its own words when there are none", async () => {
    vi.stubGlobal("fetch", respond(400, { error: "Check the highlighted details.", fields: { memo: "Too long." } }));
    expect(await writePayoutDetails({ method: "xlm", name: "A", address: G, memo: null, memoType: null })).toEqual({
      message: "Check the highlighted details.",
      fields: { memo: "Too long." },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    expect(await writePayoutDetails({ method: "xlm", name: "A", address: G, memo: null, memoType: null })).toEqual({
      message: SAVE_FAILED,
      fields: {},
    });
  });
});
