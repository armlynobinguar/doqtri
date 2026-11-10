import { afterEach, describe, expect, it, vi } from "vitest";
import { NoResponseError } from "@/lib/no-response";
import { renameNote } from "@/lib/rename-note";

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
  it("sends the title alone, and answers the rename (D-121)", async () => {
    answer(200, { id: "n1", title: "Roadmap", previousTitle: "Plan" });
    await expect(renameNote("n1", "Roadmap")).resolves.toEqual({ title: "Roadmap", previousTitle: "Plan" });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/notes/n1");
    expect(init).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String(init?.body))).toEqual({ title: "Roadmap" });
  });

  it("throws the server's reason for a refusal", async () => {
    answer(409, { error: "Another note is already called “Roadmap”", code: "TITLE_TAKEN" });
    const error = await renameNote("n1", "Roadmap").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NoResponseError);
    expect(error).toMatchObject({ message: "Another note is already called “Roadmap”" });
  });

  it("still throws, with the status, when the answer is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 500 })));
    const error = await renameNote("n1", "Roadmap").catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(NoResponseError);
    expect(error).toMatchObject({ message: "Could not rename note (500)" });
  });

  // A gateway's own page (DOQ-32): the rename may have happened, so it is not a refusal.
  it("throws NoResponseError for a gateway answer that is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 502 })));
    const error = await renameNote("n1", "Roadmap").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoResponseError);
  });
});
