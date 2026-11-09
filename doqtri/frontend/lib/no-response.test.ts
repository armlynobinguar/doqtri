import { afterEach, describe, expect, it, vi } from "vitest";
import { NoResponseError } from "@/lib/no-response";
import { renameNote } from "@/lib/rename-note";
import { deleteNote, DeleteNoteError } from "@/lib/delete-note";

/*
 * A refusal and a lost answer read differently in the vault: one failed, the
 * other may have saved. The two client calls the vault makes optimistically
 * keep them apart.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("no answer from the server", () => {
  it("is a NoResponseError when fetch rejects, for rename and delete", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(renameNote("a", "Apex")).rejects.toBeInstanceOf(NoResponseError);
    await expect(deleteNote("a")).rejects.toBeInstanceOf(NoResponseError);
  });

  it("is not confused with a refusal, which carries the server's reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "Another note is already called “Apex”", code: "TITLE_TAKEN" }, { status: 409 }),
      ),
    );
    const rename = renameNote("a", "Apex");
    await expect(rename).rejects.not.toBeInstanceOf(NoResponseError);
    await expect(rename).rejects.toThrow("Another note is already called “Apex”");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Anchored", code: "ANCHORED" }, { status: 409 })),
    );
    const refusal = await deleteNote("a").catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DeleteNoteError);
    expect((refusal as DeleteNoteError).code).toBe("ANCHORED");
  });

  it("sends the request with a timeout, so a hung request ends", async () => {
    const fetch = vi.fn(async () => Response.json({ title: "Apex", previousTitle: "Alpha" }));
    vi.stubGlobal("fetch", fetch);
    await renameNote("a", "Apex");
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
