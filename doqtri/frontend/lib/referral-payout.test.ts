import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  lastCharacters,
  PASSKEY_ADDRESS,
  PAYOUT_MEMO_MAX_BYTES,
  payoutSummary,
  utf8Bytes,
  validatePayoutProfile,
  type PayoutFieldErrors,
} from "@/lib/referral-payout";

/**
 * The payout questionnaire's validator (WP-4.6, DOQ-25, D-112), which the form
 * and PUT /api/referrals/payout-profile share. AC 2, AC 3 and the memo's byte
 * limit (AC 8).
 */

const G = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
/** The same address with its last character changed: the right shape, a wrong checksum. */
const BAD_CHECKSUM = G.slice(0, -1) + (G.endsWith("A") ? "B" : "A");
const C = StrKey.encodeContract(Buffer.alloc(32, 7));
const M = StrKey.encodeMed25519PublicKey(Buffer.alloc(40, 7));

const xlm = (over: Record<string, unknown> = {}) => ({ name: "A Referrer", method: "xlm", address: G, ...over });
const ewallet = (over: Record<string, unknown> = {}) => ({
  name: "A Referrer",
  method: "ewallet",
  provider: "GCash",
  accountName: "A Referrer",
  accountNumber: "0917 123 4567",
  ...over,
});

function errorsOf(input: unknown): PayoutFieldErrors {
  const result = validatePayoutProfile(input);
  if (result.ok) throw new Error("expected it to be refused");
  return result.errors;
}

describe("a Stellar address (AC 2)", () => {
  it("takes a valid G address", () => {
    expect(StrKey.isValidEd25519PublicKey(G)).toBe(true);
    expect(validatePayoutProfile(xlm())).toEqual({
      ok: true,
      profile: { method: "xlm", name: "A Referrer", address: G, memo: null },
    });
  });

  it("refuses one with a bad checksum", () => {
    expect(BAD_CHECKSUM).toMatch(/^G[A-Z2-7]{55}$/);
    expect(errorsOf(xlm({ address: BAD_CHECKSUM })).address).toBe(
      "This isn't a valid Stellar address. It starts with G and has 56 characters.",
    );
  });

  it("refuses a passkey wallet's C address, saying why", () => {
    expect(errorsOf(xlm({ address: C })).address).toBe(PASSKEY_ADDRESS);
    expect(PASSKEY_ADDRESS).toContain("passkey wallet (C…)");
  });

  it("refuses a C address with a typo in it the same way, rather than as merely invalid", () => {
    expect(errorsOf(xlm({ address: C.slice(0, -1) + (C.endsWith("A") ? "B" : "A") })).address).toBe(PASSKEY_ADDRESS);
  });

  it("refuses a muxed M address, pointing to the G address and memo", () => {
    expect(errorsOf(xlm({ address: M })).address).toContain("muxed (M…) address");
  });

  it.each([
    ["one short", G.slice(0, -1)],
    ["one long", G + "A"],
    ["in lower case", G.toLowerCase()],
    ["a secret key", Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).secret()],
    ["nonsense", "not an address"],
  ])("refuses an address %s", (_name, address) => {
    expect(errorsOf(xlm({ address })).address).toContain("isn't a valid Stellar address");
  });

  it("is required for XLM", () => {
    expect(errorsOf(xlm({ address: "" })).address).toBe("Enter your Stellar address.");
    expect(errorsOf(xlm({ address: undefined })).address).toBe("Enter your Stellar address.");
    expect(errorsOf(xlm({ address: "   " })).address).toBe("Enter your Stellar address.");
  });

  it("is trimmed", () => {
    const result = validatePayoutProfile(xlm({ address: `  ${G}\u00a0 ` }));
    expect(result.ok && result.profile.method === "xlm" && result.profile.address).toBe(G);
  });
});

describe("a memo: 28 bytes of UTF-8, not 28 characters (AC 2, AC 8)", () => {
  const memo = (value: string) => validatePayoutProfile(xlm({ memo: value }));

  it("is optional, and empty or blank is none", () => {
    for (const value of [undefined, null, "", "   "]) {
      const result = validatePayoutProfile(xlm({ memo: value }));
      expect(result.ok && result.profile.method === "xlm" && result.profile.memo).toBeNull();
    }
  });

  it("takes exactly 28 ASCII bytes and refuses 29", () => {
    expect(memo("x".repeat(28)).ok).toBe(true);
    expect(memo("x".repeat(29)).ok).toBe(false);
  });

  it("takes 28 bytes of two-byte characters and refuses one byte more, though that's only 15 characters", () => {
    const fourteen = "é".repeat(14);
    expect(utf8Bytes(fourteen)).toBe(28);
    expect(memo(fourteen).ok).toBe(true);
    const over = fourteen + "x";
    expect(Array.from(over)).toHaveLength(15);
    expect(utf8Bytes(over)).toBe(29);
    expect(errorsOf(xlm({ memo: over })).memo).toBe(
      `A memo can be at most ${PAYOUT_MEMO_MAX_BYTES} bytes. Some characters count as more than one.`,
    );
  });

  it("counts a four-byte emoji as four: seven fit, seven and a letter don't", () => {
    expect(memo("😀".repeat(7)).ok).toBe(true);
    expect(memo("😀".repeat(7) + "x").ok).toBe(false);
  });

  it("is trimmed before it's counted", () => {
    const result = memo(`  ${"x".repeat(28)}  `);
    expect(result.ok && result.profile.method === "xlm" && result.profile.memo).toBe("x".repeat(28));
  });
});

describe("what each method requires (AC 3)", () => {
  it("XLM needs only the name and address", () => {
    expect(validatePayoutProfile({ name: "A Referrer", method: "xlm", address: G }).ok).toBe(true);
  });

  it("e-wallet needs the provider, account name and number, with details optional", () => {
    expect(validatePayoutProfile(ewallet()).ok).toBe(true);
    expect(errorsOf(ewallet({ provider: undefined }))).toEqual({ provider: "Choose a provider." });
    expect(errorsOf(ewallet({ accountName: "" }))).toEqual({ accountName: "Enter the name on the account." });
    expect(errorsOf(ewallet({ accountNumber: " " }))).toEqual({ accountNumber: "Enter your account or bank number." });
  });

  it("takes each provider the form offers, and no other", () => {
    for (const provider of ["GCash", "Maya", "Bank", "Other"]) expect(validatePayoutProfile(ewallet({ provider })).ok).toBe(true);
    for (const provider of ["gcash", "PayPal", "", 3]) expect(errorsOf(ewallet({ provider })).provider).toBeDefined();
  });

  it("the name is always required", () => {
    expect(errorsOf(xlm({ name: "" })).name).toBe("Enter your name.");
    expect(errorsOf(ewallet({ name: "   " })).name).toBe("Enter your name.");
    expect(errorsOf({ method: "xlm", address: G })).toEqual({ name: "Enter your name." });
  });

  it("a method is required, and only the two exist", () => {
    expect(errorsOf({ name: "A Referrer" })).toEqual({ method: "Choose how you'd like to be paid." });
    expect(errorsOf({ name: "A Referrer", method: "cash" }).method).toBeDefined();
  });

  it("reports every problem at once", () => {
    expect(Object.keys(errorsOf({ method: "ewallet" })).sort()).toEqual(
      ["accountName", "accountNumber", "name", "provider"].sort(),
    );
  });
});

describe("switching method (AC 4)", () => {
  it("keeps only XLM's fields when XLM is chosen, whatever else was typed", () => {
    const result = validatePayoutProfile({ ...ewallet(), method: "xlm", address: G, memo: "77" });
    expect(result).toEqual({ ok: true, profile: { method: "xlm", name: "A Referrer", address: G, memo: "77" } });
  });

  it("keeps only the e-wallet's fields when it's chosen, and the other method's problems don't count", () => {
    const result = validatePayoutProfile({ ...ewallet(), address: C, memo: "x".repeat(40) });
    expect(result).toEqual({
      ok: true,
      profile: {
        method: "ewallet",
        name: "A Referrer",
        provider: "GCash",
        accountName: "A Referrer",
        accountNumber: "0917 123 4567",
        details: null,
      },
    });
  });

  it("drops anything that isn't a field, such as a user_id", () => {
    const result = validatePayoutProfile(xlm({ user_id: "00000000-0000-4000-8000-000000000009", admin: true }));
    expect(result.ok && Object.keys(result.profile).sort()).toEqual(["address", "memo", "method", "name"]);
  });
});

describe("an account or bank number, checked loosely", () => {
  it.each(["09171234567", "0917 123 4567", "0917-123-4567", "+63 917 123 4567", "PH12 3456 7890", "123456"])(
    "takes %s",
    (accountNumber) => expect(validatePayoutProfile(ewallet({ accountNumber })).ok).toBe(true),
  );

  it.each([
    ["too few digits", "12345"],
    ["no digits", "abcdefgh"],
    ["fullwidth digits only", "１２３４５６７"],
  ])("refuses %s", (_name, accountNumber) => {
    expect(errorsOf(ewallet({ accountNumber })).accountNumber).toBe(
      "This doesn't look like an account number: it needs more digits.",
    );
  });

  it("refuses one over 40 characters", () => {
    expect(errorsOf(ewallet({ accountNumber: "1".repeat(41) })).accountNumber).toBe("Use 40 characters or fewer.");
    expect(validatePayoutProfile(ewallet({ accountNumber: "1".repeat(40) })).ok).toBe(true);
  });
});

describe("text in every field", () => {
  it("is trimmed", () => {
    const result = validatePayoutProfile(
      ewallet({ name: "  A Referrer ", accountName: "\tHolder ", accountNumber: " 09171234567 ", details: "  Main  " }),
    );
    // A tab at the edge is whitespace, trimmed away rather than refused.
    expect(result.ok && result.profile).toMatchObject({
      name: "A Referrer",
      accountName: "Holder",
      accountNumber: "09171234567",
      details: "Main",
    });
  });

  it.each([
    ["a line break", "A\nReferrer"],
    ["a carriage return", "A\rReferrer"],
    ["a tab inside", "A\tReferrer"],
    ["a NUL", "A\u0000Referrer"],
    ["DEL", "A\u007fReferrer"],
    ["a C1 control", "A\u0085Referrer"],
    ["a right-to-left override", "A\u202eReferrer"],
    ["a bidi isolate", "A\u2067Referrer"],
    ["a byte order mark", "A\ufeffReferrer"],
    ["a line separator", "A\u2028Referrer"],
    ["a lone surrogate", "A\ud800Referrer"],
  ])("refuses %s, in any field", (_name, value) => {
    const message = "Remove the line breaks or special characters.";
    expect(errorsOf(xlm({ name: value })).name).toBe(message);
    expect(errorsOf(xlm({ memo: value })).memo).toBe(message);
    expect(errorsOf(ewallet({ accountName: value })).accountName).toBe(message);
    expect(errorsOf(ewallet({ accountNumber: `0917${value}1234567` })).accountNumber).toBe(message);
    expect(errorsOf(ewallet({ details: value })).details).toBe(message);
  });

  it("takes letters from any script, and an emoji", () => {
    expect(validatePayoutProfile(xlm({ name: "Ñandú Example-Ünïcode 李 😀" })).ok).toBe(true);
  });

  it("counts characters as Postgres does: 100 emoji are 100, not 200", () => {
    expect(validatePayoutProfile(xlm({ name: "😀".repeat(100) })).ok).toBe(true);
    expect(errorsOf(xlm({ name: "😀".repeat(101) })).name).toBe("Use 100 characters or fewer.");
    expect(errorsOf(ewallet({ details: "d".repeat(201) })).details).toBe("Use 200 characters or fewer.");
    expect(errorsOf(ewallet({ accountName: "a".repeat(101) })).accountName).toBe("Use 100 characters or fewer.");
  });

  it("refuses what isn't text", () => {
    expect(errorsOf(xlm({ name: 42 })).name).toBe("Enter this as text.");
    expect(errorsOf(xlm({ address: ["G"] })).address).toBe("Enter this as text.");
    expect(errorsOf(xlm({ memo: { text: "x" } })).memo).toBe("Enter this as text.");
  });

  it("refuses what isn't an object at all", () => {
    for (const input of [null, undefined, "xlm", 7, []]) expect(validatePayoutProfile(input).ok).toBe(false);
  });

  it("never quotes what was typed in a message", () => {
    const secret = "SECRET9876543210";
    const messages = [
      ...Object.values(errorsOf(xlm({ name: `${secret}\n${secret}`, address: `G${secret}`, memo: secret.repeat(3) }))),
      ...Object.values(
        errorsOf(
          ewallet({
            name: secret.repeat(9),
            accountName: `${secret}\u202e${secret}`,
            accountNumber: secret.repeat(4),
            details: `${secret}\n${secret}`,
          }),
        ),
      ),
    ];
    expect(messages).toHaveLength(7);
    for (const message of messages) expect(message).not.toContain("SECRET");
  });
});

describe("the masked summary", () => {
  it("is the method and the last four characters of the address", () => {
    expect(payoutSummary({ method: "xlm", name: "A Referrer", address: G, memo: "12" })).toEqual({
      label: "XLM",
      last4: G.slice(-4),
    });
  });

  it("is the provider and the last four of the number, ignoring spaces and dashes", () => {
    expect(
      payoutSummary({
        method: "ewallet",
        name: "A Referrer",
        provider: "Maya",
        accountName: "A Referrer",
        accountNumber: "0917-123 45 67",
        details: null,
      }),
    ).toEqual({ label: "Maya", last4: "4567" });
  });

  it("never shows more than half of a short value, and nothing of a single character", () => {
    expect(lastCharacters("123456")).toBe("456");
    expect(lastCharacters("12")).toBe("2");
    expect(lastCharacters("1")).toBe("");
    expect(lastCharacters("")).toBe("");
  });
});
