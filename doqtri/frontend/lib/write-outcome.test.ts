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
    // A write that hit WRITE_TIMEOUT_MS is aborted, which supabase-js also reports as status 0.
    expect(mayHaveLanded(supabaseWriteError({ message: "AbortError: signal timed out" }, 0))).toBe(true);
    // Something thrown that is not an Error says nothing about the write.
    expect(writeFailureMessage("boom", "x")).toBe(UNCONFIRMED_WRITE);
  });

  it("shows a TypeError as it is: supabase-js reports a failed fetch as status 0, so this is a bug", () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'label')");
    expect(mayHaveLanded(bug)).toBe(false);
    expect(writeFailureMessage(bug, "x")).toBe(bug.message);
  });
});
