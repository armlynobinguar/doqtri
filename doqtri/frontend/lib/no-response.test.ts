import { afterEach, describe, expect, it, vi } from "vitest";
import { NoResponseError } from "@/lib/no-response";
import { renameNote } from "@/lib/rename-note";
import { deleteNote, DeleteNoteError } from "@/lib/delete-note";

/*
 * A refusal and a lost answer read differently in the vault: one failed, the
 * other may have saved. The two client calls the vault makes optimistically
 * keep them apart.
 */

/** A body that fails mid-read, as one does when the timeout fires. */
function cutOffBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.error(new DOMException("The operation timed out.", "TimeoutError"));
    },
  });
}

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

  it("takes a 200 as done even when its body is lost or unreadable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(cutOffBody(), { status: 200 })));
    await expect(renameNote("a", "Apex")).resolves.toEqual({ title: "Apex", previousTitle: "" });
    await expect(deleteNote("a")).resolves.toMatchObject({ purgedUploads: 0 });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200 })));
    await expect(renameNote("a", "Apex")).resolves.toMatchObject({ title: "Apex" });
  });

  it("is a NoResponseError when a refusal's body is cut off before its reason arrives", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(cutOffBody(), { status: 409 })));
    await expect(renameNote("a", "Apex")).rejects.toBeInstanceOf(NoResponseError);
  });

  it("is a NoResponseError for a gateway's timeout or outage, but not for the app's own 503", async () => {
    for (const status of [408, 502, 503, 504]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Bad gateway</html>", { status })));
      await expect(renameNote("a", "Apex")).rejects.toBeInstanceOf(NoResponseError);
      await expect(deleteNote("a")).rejects.toBeInstanceOf(NoResponseError);
    }

    // The delete route's own refusal when Stellar is down: nothing was deleted.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "Could not reach Stellar to check whether this note is anchored. Try again.", code: "CHAIN_UNREACHABLE" },
          { status: 503 },
        ),
      ),
    );
    const refusal = await deleteNote("a").catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DeleteNoteError);
    expect((refusal as DeleteNoteError).code).toBe("CHAIN_UNREACHABLE");
  });

  it("sends the request with a timeout, so a hung request ends", async () => {
    const fetch = vi.fn(async () => Response.json({ title: "Apex", previousTitle: "Alpha" }));
    vi.stubGlobal("fetch", fetch);
    await renameNote("a", "Apex");
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
