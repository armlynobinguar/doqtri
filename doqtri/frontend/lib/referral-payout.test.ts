import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  lastCharacters,
  PASSKEY_ADDRESS,
  payoutSummary,
  validatePayoutProfile,
  type PayoutFieldErrors,
} from "@/lib/referral-payout";

/**
 * The payout questionnaire's validator (WP-4.6, DOQ-25, D-112), which the form
 * and PUT /api/referrals/payout-profile share. AC 2, AC 3 and the memo's byte
 * limit (AC 8), and that nothing invisible or look-alike gets through.
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
  if (result.ok) throw new Error(`expected it to be refused: ${JSON.stringify(input)}`);
  return result.errors;
}
const accepted = (input: unknown) => validatePayoutProfile(input).ok;

/** Every character the review found getting through, by name. */
const INVISIBLE: [string, string][] = [
  ["a zero-width space", "\u200b"],
  ["a zero-width non-joiner", "\u200c"],
  ["a zero-width joiner", "\u200d"],
  ["a left-to-right mark", "\u200e"],
  ["a right-to-left override", "\u202e"],
  ["a bidi isolate", "\u2067"],
  ["a word joiner", "\u2060"],
  ["a soft hyphen", "\u00ad"],
  ["a byte order mark", "\ufeff"],
  ["a tag character", "\u{e0041}"],
  ["a line separator", "\u2028"],
  ["a Hangul filler", "\u3164"],
  ["a halfwidth Hangul filler", "\uffa0"],
  ["a Hangul choseong filler", "\u115f"],
  ["a Hangul jungseong filler", "\u1160"],
  ["a blank Braille pattern", "\u2800"],
  ["a line break", "\n"],
  ["a tab inside", "\t"],
  ["a NUL", "\u0000"],
  ["DEL", "\u007f"],
  ["a C1 control", "\u0085"],
  ["a lone surrogate", "\ud800"],
];

describe("a Stellar address (AC 2)", () => {
  it("takes a valid G address", () => {
    expect(StrKey.isValidEd25519PublicKey(G)).toBe(true);
    expect(validatePayoutProfile(xlm())).toEqual({
      ok: true,
      profile: { method: "xlm", name: "A Referrer", address: G, memo: null, memoType: null },
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
    ["a federation address", "someone*example.com"],
    ["a Cyrillic look-alike G", "\u0413" + G.slice(1)],
    ["a zero-width space inside", G.slice(0, 10) + "\u200b" + G.slice(10)],
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
    const result = validatePayoutProfile(xlm({ address: `  ${G}\u00a0\u3000` }));
    expect(result.ok && result.profile.method === "xlm" && result.profile.address).toBe(G);
  });
});

describe("a text memo: printable ASCII, 28 bytes at most (AC 2, AC 8)", () => {
  const memo = (value: unknown, memoType: unknown = "text") => validatePayoutProfile(xlm({ memo: value, memoType }));
  const memoOf = (value: unknown, memoType: unknown = "text") => {
    const result = memo(value, memoType);
    return result.ok && result.profile.method === "xlm" ? [result.profile.memo, result.profile.memoType] : null;
  };

  it("is optional, and empty or blank is none, with no type, whatever type was sent", () => {
    for (const value of [undefined, null, "", "   "]) {
      for (const type of ["text", "id", undefined, "nonsense"]) expect(memoOf(value, type)).toEqual([null, null]);
    }
  });

  it("takes exactly 28 characters and refuses 29", () => {
    expect(memoOf("x".repeat(28))).toEqual(["x".repeat(28), "text"]);
    expect(errorsOf(xlm({ memo: "x".repeat(29), memoType: "text" })).memo).toBe(
      "A text memo can be at most 28 characters.",
    );
  });

  it("takes spaces and common symbols inside, all of printable ASCII", () => {
    const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)).join("");
    for (let i = 0; i < printable.length; i += 28) {
      const piece = printable.slice(i, i + 28).trim();
      expect(memo(piece).ok, JSON.stringify(piece)).toBe(true);
    }
  });

  it.each([
    ["two-byte letters, though 14 of them are only 28 bytes", "é".repeat(14)],
    ["the same in NFD", "e\u0301"],
    ["fullwidth digits", "\uff11\uff12\uff13"],
    ["Arabic-Indic digits", "\u0661\u0662\u0663"],
    ["an emoji", "\u{1f600}"],
    ["a variation selector", "123\ufe0f"],
    ["a combining grapheme joiner", "12\u034f3"],
    ...INVISIBLE.map(([name, ch]): [string, string] => [name, `123${ch}456`]),
  ])("refuses %s", (_name, value) => {
    expect(errorsOf(xlm({ memo: value, memoType: "text" })).memo).toBeDefined();
  });

  it("says why, in the words the form shows", () => {
    expect(errorsOf(xlm({ memo: "123456\u200b", memoType: "text" })).memo).toBe(
      "A text memo can use only English letters, digits, spaces and common symbols.",
    );
  });

  it("is trimmed before it's counted", () => {
    expect(memoOf(`  ${"x".repeat(28)}  `)).toEqual(["x".repeat(28), "text"]);
  });

  it("isn't text if it isn't a string", () => {
    expect(errorsOf(xlm({ memo: 12345, memoType: "id" })).memo).toBe("Enter this as text.");
  });
});

describe("an ID memo: an unsigned 64-bit integer in decimal", () => {
  const id = (value: string) => validatePayoutProfile(xlm({ memo: value, memoType: "id" }));

  it.each(["0", "1", "12345", "9007199254740993", "18446744073709551615"])("takes %s", (value) => {
    const result = id(value);
    expect(result.ok && result.profile.method === "xlm" && [result.profile.memo, result.profile.memoType]).toEqual([
      value,
      "id",
    ]);
  });

  it("refuses one past the largest, exactly at the boundary", () => {
    expect(errorsOf(xlm({ memo: "18446744073709551616", memoType: "id" })).memo).toBe(
      "An ID memo can be at most 18446744073709551615.",
    );
    expect(id("99999999999999999999").ok).toBe(false);
    expect(id("184467440737095516150").ok).toBe(false);
  });

  it.each([
    ["a plus sign", "+1"],
    ["a minus sign", "-1"],
    ["a space inside", "12 34"],
    ["a leading zero", "007"],
    ["a decimal point", "1.5"],
    ["an exponent", "1e5"],
    ["a letter", "12a"],
    ["fullwidth digits", "\uff11\uff12"],
    ["a zero-width space", "12\u200b34"],
  ])("refuses %s", (_name, value) => {
    expect(errorsOf(xlm({ memo: value, memoType: "id" })).memo).toBe(
      "An ID memo is a whole number, with no spaces, sign or leading zeros.",
    );
  });

  it("is trimmed first, like every field", () => {
    expect(id("  42 ").ok).toBe(true);
  });
});

describe("a memo's type", () => {
  it("is required once there's a memo", () => {
    expect(errorsOf(xlm({ memo: "12345" }))).toEqual({ memoType: "Choose whether the memo is text or an ID." });
    expect(errorsOf(xlm({ memo: "12345", memoType: "number" })).memoType).toBeDefined();
    expect(errorsOf(xlm({ memo: "12345", memoType: "TEXT" })).memoType).toBeDefined();
  });

  it("decides how the memo is checked: digits are fine as text, letters aren't an ID", () => {
    expect(accepted(xlm({ memo: "12345", memoType: "text" }))).toBe(true);
    expect(accepted(xlm({ memo: "abc", memoType: "id" }))).toBe(false);
    // Too long for text, fine as an ID.
    expect(accepted(xlm({ memo: "18446744073709551615" + "12345678", memoType: "text" }))).toBe(true);
    expect(accepted(xlm({ memo: "1".repeat(29), memoType: "text" }))).toBe(false);
  });
});

describe("what each method requires (AC 3)", () => {
  it("XLM needs only the name and address", () => {
    expect(accepted({ name: "A Referrer", method: "xlm", address: G })).toBe(true);
  });

  it("e-wallet needs the provider, account name and number, with details optional", () => {
    expect(accepted(ewallet())).toBe(true);
    expect(errorsOf(ewallet({ provider: undefined }))).toEqual({ provider: "Choose a provider." });
    expect(errorsOf(ewallet({ accountName: "" }))).toEqual({ accountName: "Enter the name on the account." });
    expect(errorsOf(ewallet({ accountNumber: " " }))).toEqual({ accountNumber: "Enter your account or bank number." });
  });

  it("takes each provider the form offers, and no other", () => {
    for (const provider of ["GCash", "Maya", "Bank", "Other"]) expect(accepted(ewallet({ provider }))).toBe(true);
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
    expect(errorsOf({ name: "A Referrer", method: ["xlm"], address: G }).method).toBeDefined();
  });

  it("reports every problem at once", () => {
    expect(Object.keys(errorsOf({ method: "ewallet" })).sort()).toEqual(
      ["accountName", "accountNumber", "name", "provider"].sort(),
    );
  });
});

describe("switching method (AC 4)", () => {
  it("keeps only XLM's fields when XLM is chosen, whatever else was typed", () => {
    const result = validatePayoutProfile({ ...ewallet(), method: "xlm", address: G, memo: "77", memoType: "id" });
    expect(result).toEqual({
      ok: true,
      profile: { method: "xlm", name: "A Referrer", address: G, memo: "77", memoType: "id" },
    });
  });

  it("keeps only the e-wallet's fields when it's chosen, and the other method's problems don't count", () => {
    const result = validatePayoutProfile({ ...ewallet(), address: C, memo: "x".repeat(40), memoType: "nonsense" });
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
    expect(result.ok && Object.keys(result.profile).sort()).toEqual(["address", "memo", "memoType", "method", "name"]);
  });
});

describe("an account or bank number: ASCII, with digits", () => {
  it.each(["09171234567", "0917 123 4567", "0917-123-4567", "PH12 3456 7890", "123456", "ABCD-123456"])(
    "takes %s",
    (accountNumber) => expect(accepted(ewallet({ accountNumber }))).toBe(true),
  );

  it.each([
    ["too few digits", "12345"],
    ["no digits", "abcdefgh"],
  ])("refuses %s", (_name, accountNumber) => {
    expect(errorsOf(ewallet({ accountNumber })).accountNumber).toBe(
      "This doesn't look like an account number: it needs more digits.",
    );
  });

  it.each([
    ["fullwidth digits", "091712\uff13\uff14\uff15\uff16\uff17"],
    ["fullwidth digits only", "\uff11\uff12\uff13\uff14\uff15\uff16\uff17"],
    ["Arabic-Indic digits beside six ASCII ones", "091712\u0663\u0664"],
    ["six digits and symbols", "123456!!!!$$$$"],
    ["a plus sign", "+63 917 123 4567"],
    ["a dot", "0917.123.4567"],
    ["an accented letter", "PHÉ12345678"],
    ...INVISIBLE.map(([name, ch]): [string, string] => [name, `0917${ch}1234567`]),
  ])("refuses %s", (_name, accountNumber) => {
    expect(errorsOf(ewallet({ accountNumber })).accountNumber).toBeDefined();
  });

  it("says which characters it takes", () => {
    expect(errorsOf(ewallet({ accountNumber: "0917\u200b1234567" })).accountNumber).toBe(
      "Use only digits, English letters, spaces and dashes.",
    );
  });

  it("still takes a letter O, which can't be told from a zero by its characters alone", () => {
    // Letters stay, for IBAN-style numbers; the admin sees exactly these ASCII characters.
    expect(accepted(ewallet({ accountNumber: "O9171234567" }))).toBe(true);
  });

  it("refuses one over 40 characters", () => {
    expect(errorsOf(ewallet({ accountNumber: "1".repeat(41) })).accountNumber).toBe("Use 40 characters or fewer.");
    expect(accepted(ewallet({ accountNumber: "1".repeat(40) }))).toBe(true);
  });
});

describe("names and details", () => {
  it("are trimmed", () => {
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

  it.each(INVISIBLE)("refuse %s, in each of them", (_name, ch) => {
    const message = "Remove the line breaks or special characters.";
    const value = `A${ch}Referrer`;
    expect(errorsOf(xlm({ name: value })).name).toBe(message);
    expect(errorsOf(ewallet({ accountName: value })).accountName).toBe(message);
    expect(errorsOf(ewallet({ details: value })).details).toBe(message);
  });

  it.each([
    ["a zero-width space", "\u200b"],
    ["two of them", "\u200b\u200b"],
    ["a blank Braille pattern", "\u2800"],
    ["a Hangul filler", "\u3164"],
  ])("can't be made of %s alone to look filled in", (_name, value) => {
    expect(errorsOf(xlm({ name: value })).name).toBeDefined();
    expect(errorsOf(ewallet({ accountName: value })).accountName).toBeDefined();
  });

  it("need at least one letter or number, in any script", () => {
    expect(errorsOf(xlm({ name: "- . !" })).name).toBe("Use at least one letter or number.");
    expect(errorsOf(xlm({ name: "\u{1f600}" })).name).toBe("Use at least one letter or number.");
    expect(errorsOf(ewallet({ details: "--" })).details).toBe("Use at least one letter or number.");
    expect(accepted(xlm({ name: "李小龙" }))).toBe(true);
    expect(accepted(xlm({ name: "7" }))).toBe(true);
  });

  it("take a name in NFC and in NFD, combining marks and all", () => {
    const nfc = "José Ñandú Example";
    const nfd = nfc.normalize("NFD");
    expect(nfd).not.toBe(nfc);
    expect(accepted(xlm({ name: nfc }))).toBe(true);
    expect(accepted(xlm({ name: nfd }))).toBe(true);
    expect(accepted(ewallet({ accountName: nfd, details: nfd }))).toBe(true);
  });

  it("take an emoji beside letters, and spaces of any width between words", () => {
    expect(accepted(xlm({ name: "Ñandú Example-Ünïcode 李 \u{1f600}" }))).toBe(true);
    expect(accepted(xlm({ name: "A\u3000Referrer" }))).toBe(true);
  });

  it("count characters as Postgres does: 100 letters outside the BMP are 100, not 200", () => {
    expect(accepted(xlm({ name: "\u{10400}".repeat(100) }))).toBe(true);
    expect(errorsOf(xlm({ name: "\u{10400}".repeat(101) })).name).toBe("Use 100 characters or fewer.");
    expect(errorsOf(ewallet({ details: "d".repeat(201) })).details).toBe("Use 200 characters or fewer.");
    expect(errorsOf(ewallet({ accountName: "a".repeat(101) })).accountName).toBe("Use 100 characters or fewer.");
  });

  it("refuse what isn't text", () => {
    expect(errorsOf(xlm({ name: 42 })).name).toBe("Enter this as text.");
    expect(errorsOf(xlm({ address: ["G"] })).address).toBe("Enter this as text.");
    expect(errorsOf(xlm({ memo: { text: "x" } })).memo).toBe("Enter this as text.");
  });
});

describe("any input", () => {
  it("that isn't an object is refused", () => {
    for (const input of [null, undefined, "xlm", 7, []]) expect(accepted(input)).toBe(false);
  });

  it("is never quoted back in a message", () => {
    const secret = "SECRET9876543210";
    const messages = [
      ...Object.values(errorsOf(xlm({ name: `${secret}\n${secret}`, address: `G${secret}`, memo: secret.repeat(3), memoType: "text" }))),
      ...Object.values(errorsOf(xlm({ name: "A", memo: `${secret}x`, memoType: "id" }))),
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
    expect(messages).toHaveLength(8);
    for (const message of messages) expect(message).not.toContain("SECRET");
  });
});

describe("the masked summary", () => {
  it("is the method, the last four characters of the address, and the memo's type, never the memo", () => {
    const summary = payoutSummary({ method: "xlm", address: G, memoType: "id" });
    expect(summary).toEqual({ label: "XLM", last4: G.slice(-4), memoType: "id" });
    expect(payoutSummary({ method: "xlm", address: G, memoType: null }).memoType).toBeNull();
  });

  it("is the provider and the last four of the number, ignoring spaces and dashes", () => {
    expect(payoutSummary({ method: "ewallet", provider: "Maya", accountNumber: "0917-123 45 67" })).toEqual({
      label: "Maya",
      last4: "4567",
    });
  });

  it("never shows more than half of a short value, and nothing of a single character", () => {
    expect(lastCharacters("123456")).toBe("456");
    expect(lastCharacters("12")).toBe("2");
    expect(lastCharacters("1")).toBe("");
    expect(lastCharacters("")).toBe("");
  });
});
