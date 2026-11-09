import { describe, expect, it } from "vitest";
import {
  isUnanswered,
  mayHaveLanded,
  supabaseWriteError,
  UNCONFIRMED_WRITE,
  UnconfirmedWriteError,
  writeFailureMessage,
} from "@/lib/write-outcome";

describe("refused or unanswered writes (DOQ-33)", () => {
  it("treats no response, timeouts and gateway failures as unanswered", () => {
    for (const status of [0, 408, 502, 503, 504, 520, 524]) expect(isUnanswered(status), String(status)).toBe(true);
    for (const status of [200, 400, 401, 403, 404, 409, 500, 501]) expect(isUnanswered(status), String(status)).toBe(false);
  });

  it("shows the server's message for a refusal", () => {
    const refused = supabaseWriteError({ message: "Only an owner can make someone an admin." }, 400);
    expect(refused).not.toBeInstanceOf(UnconfirmedWriteError);
    expect(mayHaveLanded(refused)).toBe(false);
    expect(writeFailureMessage(refused, "role failed")).toBe("Only an owner can make someone an admin.");
    expect(writeFailureMessage(new Error(""), "role failed")).toBe("role failed");
  });

  it("says the change may not have saved when there was no answer", () => {
    // supabase-js turns a failed fetch into `{ error, status: 0 }`.
    const lost = supabaseWriteError({ message: "TypeError: Failed to fetch" }, 0);
    expect(lost).toBeInstanceOf(UnconfirmedWriteError);
    expect(mayHaveLanded(lost)).toBe(true);
    expect(writeFailureMessage(lost, "role failed")).toBe(UNCONFIRMED_WRITE);
    // A bare fetch rejects with a TypeError; anything not an Error is just as unknown.
    expect(writeFailureMessage(new TypeError("Failed to fetch"), "x")).toBe(UNCONFIRMED_WRITE);
    expect(writeFailureMessage("boom", "x")).toBe(UNCONFIRMED_WRITE);
  });
});
