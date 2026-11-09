import { afterEach, describe, expect, it, vi } from "vitest";
import { RenameError, renameNote } from "@/lib/rename-note";

function answer(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renameNote", () => {
  it("sends the title and the editor's session, and answers the rename", async () => {
    answer(200, { id: "n1", title: "Roadmap", previousTitle: "Plan" });
    await expect(renameNote("n1", "Roadmap", "s1")).resolves.toEqual({ title: "Roadmap", previousTitle: "Plan" });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/notes/n1");
    expect(init).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String(init?.body))).toEqual({ title: "Roadmap", session: "s1" });
  });

  it("throws a RenameError with the status and code of a refusal (DOQ-36)", async () => {
    answer(409, { error: "Another note is already called “Roadmap”", code: "TITLE_TAKEN" });
    const error = await renameNote("n1", "Roadmap").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RenameError);
    expect(error).toMatchObject({ message: "Another note is already called “Roadmap”", status: 409, code: "TITLE_TAKEN" });
  });

  it("sends the title the caller expects the note to have, and reads the current one off TITLE_CHANGED", async () => {
    answer(409, { error: "This note was renamed", code: "TITLE_CHANGED", title: "Their Title" });
    const error = await renameNote("n1", "Roadmap", "s1", "Plan").catch((e: unknown) => e);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({
      title: "Roadmap",
      session: "s1",
      expectedTitle: "Plan",
    });
    expect(error).toBeInstanceOf(RenameError);
    expect(error).toMatchObject({ status: 409, code: "TITLE_CHANGED", title: "Their Title" });
  });

  it("still throws a RenameError, without a code, when the answer is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 502 })));
    const error = await renameNote("n1", "Roadmap").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RenameError);
    expect(error).toMatchObject({ message: "Could not rename note (502)", status: 502, code: undefined });
  });
});
