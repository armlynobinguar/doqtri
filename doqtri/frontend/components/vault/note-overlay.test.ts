import { act, createElement, startTransition, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONFIRMED_TTL_MS,
  EMPTY_OVERLAY,
  applyChange,
  confirmChange,
  dropChange,
  expireOverlay,
  isNotePending,
  overlayNotes,
  settleOverlay,
  useNoteOverlayState,
  type NoteOverlay,
  type RunChange,
} from "@/components/vault/note-overlay";
import { NoResponseError } from "@/lib/no-response";
import type { FailedImport, NoteSummary } from "@/lib/types";

const notes: NoteSummary[] = [
  { id: "a", title: "Alpha", updated_at: "2026-11-01" },
  { id: "b", title: "Beta", updated_at: "2026-11-02" },
];
const imports: FailedImport[] = [{ id: "ingest-1", filename: "broken.docx", error_code: "PARSE" }];

const rename = (id: string, title: string) => ({ kind: "rename" as const, id, title });
const remove = (id: string) => ({ kind: "delete" as const, id });
const dismiss = (id: string) => ({ kind: "dismiss" as const, id });

describe("the overlay, as data", () => {
  it("applies a pending rename and leaves out a pending delete, in the same order", () => {
    let overlay = applyChange(EMPTY_OVERLAY, rename("b", "Bravo"), 1);
    expect(overlayNotes(notes, overlay).map((note) => note.title)).toEqual(["Alpha", "Bravo"]);

    overlay = applyChange(overlay, remove("a"), 2);
    expect(overlayNotes(notes, overlay).map((note) => note.title)).toEqual(["Bravo"]);
    expect(isNotePending(overlay, "a")).toBe(true);
    expect(isNotePending(overlay, "b")).toBe(true);
  });

  it("hands back the same array when nothing pending touches it", () => {
    expect(overlayNotes(notes, EMPTY_OVERLAY)).toBe(notes);
    expect(overlayNotes(notes, applyChange(EMPTY_OVERLAY, dismiss("ingest-1"), 1))).toBe(notes);
    expect(overlayNotes(notes, applyChange(EMPTY_OVERLAY, remove("gone"), 1))).toBe(notes);
  });

  it("drops and confirms only the entry its token put there", () => {
    const first = applyChange(EMPTY_OVERLAY, rename("a", "One"), 1);
    const second = applyChange(first, rename("a", "Two"), 2);
    expect(dropChange(second, rename("a", "One"), 1)).toBe(second);
    expect(confirmChange(second, rename("a", "One"), 1, 5)).toBe(second);
    expect(confirmChange(second, rename("a", "Two"), 2, 5).titles.get("a")?.confirmedAt).toBe(5);
    expect(dropChange(second, rename("a", "Two"), 2).titles.size).toBe(0);
    // Never mutated along the way.
    expect(first.titles.get("a")?.title).toBe("One");
    expect(EMPTY_OVERLAY.titles.size).toBe(0);
  });

  it("settles each entry once server data shows it, and keeps the rest", () => {
    let overlay = applyChange(EMPTY_OVERLAY, rename("a", "Apex"), 1);
    overlay = applyChange(overlay, remove("b"), 2);
    overlay = applyChange(overlay, dismiss("ingest-1"), 3);
    expect(settleOverlay(overlay, notes, imports)).toBe(overlay);

    const renamed = settleOverlay(overlay, [{ ...notes[0], title: "Apex" }, notes[1]], imports);
    expect([...renamed.titles.keys()]).toEqual([]);
    expect([...renamed.deleted.keys()]).toEqual(["b"]);

    const deleted = settleOverlay(renamed, [notes[0]], imports);
    expect(deleted.deleted.size).toBe(0);
    expect(settleOverlay(deleted, [notes[0]], [])).toEqual(EMPTY_OVERLAY);

    // A rename of a note that is gone has nothing left to show.
    expect(settleOverlay(applyChange(EMPTY_OVERLAY, rename("b", "Bravo"), 4), [notes[0]], []).titles.size).toBe(0);
  });

  it("expires confirmed entries server data never showed, and only those", () => {
    let overlay = applyChange(EMPTY_OVERLAY, rename("a", "Apex"), 1);
    overlay = applyChange(overlay, remove("b"), 2);
    overlay = confirmChange(overlay, rename("a", "Apex"), 1, 1_000);
    expect(expireOverlay(overlay, 1_000 + CONFIRMED_TTL_MS - 1)).toBe(overlay);
    const expired = expireOverlay(overlay, 1_000 + CONFIRMED_TTL_MS);
    expect(expired.titles.size).toBe(0);
    // Still waiting on its request: not the fallback's to drop.
    expect(expired.deleted.has("b")).toBe(true);
  });
});

/*
 * The hook, rendered for real. The unit tests run in Node without a DOM, so
 * the root is a stub that React DOM accepts as a container; the components
 * render nothing, so React never asks it for more than this.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { window?: unknown }).window ??= globalThis;

function stubContainer(): Element {
  const document: Record<string, unknown> = {
    nodeType: 9,
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  };
  document.defaultView = { document, HTMLIFrameElement: class {} };
  return {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Element;
}

type Server = { notes: NoteSummary[]; failedImports: FailedImport[]; location: string };

/** A request the test answers by hand. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { action: () => promise, resolve, reject };
}

/**
 * Stands in for the vault shell: the layout's server data and pathname come
 * in as props, and `route` is unrelated state changed in a transition, the
 * way a router push is. Every render records the titles on screen.
 */
function mountVault() {
  const frames: string[][] = [];
  const overlays: NoteOverlay[] = [];
  const routes: string[] = [];
  const refresh = vi.fn();
  let run!: RunChange;
  let setRoute!: (route: string) => void;

  function Vault(server: Server) {
    const state = useNoteOverlayState({ ...server, refresh });
    const [route, set] = useState("note-a");
    run = state.run;
    setRoute = set;
    overlays.push(state.overlay);
    routes.push(route);
    frames.push(overlayNotes(server.notes, state.overlay).map((note) => note.title));
    return null;
  }

  const root: Root = createRoot(stubContainer());
  let server: Server = { notes, failedImports: imports, location: "/vault/a" };
  return {
    frames,
    overlays,
    routes,
    refresh,
    root,
    run: (...args: Parameters<RunChange>) => run(...args),
    navigate: (route: string) => startTransition(() => setRoute(route)),
    /** New server data (or pathname), as a refresh or navigation would bring. */
    serve: async (next: Partial<Server>) => {
      server = { ...server, ...next };
      await act(async () => root.render(createElement(Vault, server)));
    },
  };
}

describe("useNoteOverlayState", () => {
  let vault: ReturnType<typeof mountVault> | null = null;

  afterEach(async () => {
    await act(async () => vault?.root.unmount());
    vault = null;
  });

  async function mount() {
    vault = mountVault();
    await vault.serve({});
    return vault;
  }

  it("applies a change at once and lets a navigation commit while the request is out", async () => {
    const v = await mount();
    const patch = deferred();
    await act(async () => v.run(rename("a", "Apex"), patch.action, () => {}));
    expect(v.frames.at(-1)).toEqual(["Apex", "Beta"]);
    expect(v.refresh).not.toHaveBeenCalled();

    // Before: a navigation waited in the rename's transition until it settled.
    await act(async () => v.navigate("note-b"));
    expect(v.routes.at(-1)).toBe("note-b");
    expect(v.frames.at(-1)).toEqual(["Apex", "Beta"]);

    await act(async () => patch.resolve());
  });

  it("holds a confirmed change until server data shows it, then clears it", async () => {
    const v = await mount();
    const patch = deferred();
    await act(async () => v.run(rename("a", "Apex"), patch.action, () => {}));
    await act(async () => patch.resolve());
    expect(v.refresh).toHaveBeenCalledTimes(1);
    expect(v.overlays.at(-1)?.titles.get("a")?.confirmedAt).toEqual(expect.any(Number));

    // A refresh that started before the write lands with the old title: held.
    await v.serve({ notes: [...notes] });
    expect(v.frames.at(-1)).toEqual(["Apex", "Beta"]);
    expect(isNotePending(v.overlays.at(-1)!, "a")).toBe(true);

    await v.serve({ notes: [{ ...notes[0], title: "Apex" }, notes[1]] });
    expect(v.frames.at(-1)).toEqual(["Apex", "Beta"]);
    expect(v.overlays.at(-1)).toEqual(EMPTY_OVERLAY);
    const renamedAt = v.frames.findIndex((frame) => frame[0] === "Apex");
    expect(v.frames.slice(renamedAt).every((frame) => frame[0] === "Apex")).toBe(true);
  });

  it("rolls back only the refused change while another is still in flight", async () => {
    const v = await mount();
    const del = deferred();
    const patch = deferred();
    const onError = vi.fn();
    await act(async () => {
      v.run(remove("b"), del.action, () => {});
      v.run(rename("a", "Apex"), patch.action, onError);
    });
    expect(v.frames.at(-1)).toEqual(["Apex"]);

    const refusal = new Error("Someone else is editing this note");
    await act(async () => patch.reject(refusal));
    expect(onError).toHaveBeenCalledWith(refusal);
    // The old title is back at once; the delete still hides its row.
    expect(v.frames.at(-1)).toEqual(["Alpha"]);
    expect(isNotePending(v.overlays.at(-1)!, "a")).toBe(false);
    expect(isNotePending(v.overlays.at(-1)!, "b")).toBe(true);
    expect(v.refresh).not.toHaveBeenCalled();

    await act(async () => del.resolve());
    await v.serve({ notes: [notes[0]] });
    expect(v.frames.at(-1)).toEqual(["Alpha"]);
    expect(v.overlays.at(-1)).toEqual(EMPTY_OVERLAY);
  });

  it("refreshes once more after a navigation commits while a confirmed change waits", async () => {
    const v = await mount();
    await act(async () => v.run(dismiss("ingest-1"), async () => {}, () => {}));
    expect(v.refresh).toHaveBeenCalledTimes(1);

    // The navigation discarded that refresh and reused the layout's data.
    await v.serve({ location: "/vault/b" });
    expect(v.refresh).toHaveBeenCalledTimes(2);
    expect(v.overlays.at(-1)?.dismissed.has("ingest-1")).toBe(true);

    await v.serve({ failedImports: [] });
    await v.serve({ location: "/vault/a" });
    // Nothing left waiting, so nothing to refresh for.
    expect(v.refresh).toHaveBeenCalledTimes(2);
  });

  it("drops a change that got no answer, and refreshes to see what the server did", async () => {
    const v = await mount();
    const onError = vi.fn();
    await act(async () =>
      v.run(
        rename("a", "Apex"),
        () => Promise.reject(new NoResponseError()),
        onError,
      ),
    );
    expect(onError).toHaveBeenCalledWith(expect.any(NoResponseError));
    expect(v.frames.at(-1)).toEqual(["Alpha", "Beta"]);
    expect(v.refresh).toHaveBeenCalledTimes(1);
  });
});
