import {
  Suspense,
  act,
  createElement,
  startTransition,
  use,
  useState,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_OVERLAY,
  applyChange,
  isNotePending,
  overlayNotes,
  useNoteOverlayState,
  type NoteChange,
  type NoteOverlay,
} from "@/components/vault/note-overlay";
import type { NoteSummary } from "@/lib/types";

const notes: NoteSummary[] = [
  { id: "a", title: "Alpha", updated_at: "2026-11-01" },
  { id: "b", title: "Beta", updated_at: "2026-11-02" },
];

describe("overlayNotes", () => {
  it("applies a pending rename and leaves out a pending delete, in the same order", () => {
    let overlay = applyChange(EMPTY_OVERLAY, { kind: "rename", id: "b", title: "Bravo" });
    expect(overlayNotes(notes, overlay).map((note) => note.title)).toEqual(["Alpha", "Bravo"]);

    overlay = applyChange(overlay, { kind: "delete", id: "a" });
    expect(overlayNotes(notes, overlay).map((note) => note.title)).toEqual(["Bravo"]);
    expect(isNotePending(overlay, "a")).toBe(true);
    expect(isNotePending(overlay, "b")).toBe(true);
  });

  it("hands back the same array when nothing pending touches it", () => {
    expect(overlayNotes(notes, EMPTY_OVERLAY)).toBe(notes);
    const dismissed = applyChange(EMPTY_OVERLAY, { kind: "dismiss", id: "ingest-1" });
    expect(overlayNotes(notes, dismissed)).toBe(notes);
    expect(overlayNotes(notes, applyChange(EMPTY_OVERLAY, { kind: "delete", id: "gone" }))).toBe(notes);
  });

  it("never mutates the overlay it is given", () => {
    const before = applyChange(EMPTY_OVERLAY, { kind: "rename", id: "a", title: "One" });
    applyChange(before, { kind: "rename", id: "a", title: "Two" });
    applyChange(before, { kind: "delete", id: "b" });
    expect(before.titles.get("a")).toBe("One");
    expect(before.deleted.size).toBe(0);
    expect(EMPTY_OVERLAY.titles.size).toBe(0);
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

type Run = (change: NoteChange, action: () => Promise<void>, onError: (error: unknown) => void) => void;

/**
 * Stands in for the vault: `notes` is the server data, which a refresh
 * replaces in a transition that suspends until the new data "arrives", the
 * way router.refresh() does. Every render records the titles on screen.
 */
function mountVault() {
  const frames: string[][] = [];
  const overlays: NoteOverlay[] = [];
  let run!: Run;
  let respond!: (next: NoteSummary[]) => void;
  const refresh = vi.fn(() => {
    const arriving = new Promise<NoteSummary[]>((resolve) => (respond = resolve));
    startTransition(() => setServer(arriving));
  });
  let setServer!: (next: NoteSummary[] | Promise<NoteSummary[]>) => void;

  function Vault({ server }: { server: NoteSummary[] | Promise<NoteSummary[]> }) {
    const data = server instanceof Promise ? use(server) : server;
    const state = useNoteOverlayState(refresh);
    run = state.run;
    overlays.push(state.overlay);
    frames.push(overlayNotes(data, state.overlay).map((note) => note.title));
    return null;
  }

  function Server() {
    const [server, set] = useState<NoteSummary[] | Promise<NoteSummary[]>>(notes);
    setServer = set;
    return createElement(Suspense, { fallback: null }, createElement(Vault, { server }));
  }

  return {
    frames,
    overlays,
    refresh,
    run: (...args: Parameters<Run>) => run(...args),
    respond: (next: NoteSummary[]) => respond(next),
    element: createElement(Server),
  };
}

describe("useNoteOverlayState", () => {
  let root: Root | null = null;

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
  });

  async function mount() {
    const vault = mountVault();
    root = createRoot(stubContainer());
    await act(async () => root!.render(vault.element));
    return vault;
  }

  it("applies a change at once, before the request answers", async () => {
    const vault = await mount();
    let answer!: () => void;
    await act(async () => {
      vault.run(
        { kind: "rename", id: "a", title: "Apex" },
        () => new Promise<void>((resolve) => (answer = resolve)),
        () => {},
      );
    });
    expect(vault.frames.at(-1)).toEqual(["Apex", "Beta"]);
    expect(vault.overlays.at(-1)?.titles.get("a")).toBe("Apex");
    expect(vault.refresh).not.toHaveBeenCalled();

    // Settle it: React's action scope is shared by every root, so an action
    // left pending would hold the next test's transitions too.
    await act(async () => answer());
    await act(async () => vault.respond([{ ...notes[0], title: "Apex" }, notes[1]]));
  });

  it("holds the change until fresh server data commits, then settles on it", async () => {
    const vault = await mount();
    let answer!: () => void;
    await act(async () => {
      vault.run(
        { kind: "rename", id: "a", title: "Apex" },
        () => new Promise<void>((resolve) => (answer = resolve)),
        () => {},
      );
    });

    // The request answers; the refresh is under way but its data is not in.
    await act(async () => answer());
    expect(vault.refresh).toHaveBeenCalledTimes(1);
    expect(vault.frames.at(-1)).toEqual(["Apex", "Beta"]);
    expect(vault.overlays.at(-1)?.titles.size).toBe(1);

    // The server's data arrives with the new title, and the overlay is gone.
    await act(async () => vault.respond([{ ...notes[0], title: "Apex" }, notes[1]]));
    expect(vault.frames.at(-1)).toEqual(["Apex", "Beta"]);
    expect(vault.overlays.at(-1)).toBe(EMPTY_OVERLAY);

    // At no point after the rename did the old title come back.
    const renamedAt = vault.frames.findIndex((frame) => frame[0] === "Apex");
    expect(vault.frames.slice(renamedAt).every((frame) => frame[0] === "Apex")).toBe(true);
  });

  it("settles a delete on server data that no longer has the note", async () => {
    const vault = await mount();
    await act(async () => {
      vault.run({ kind: "delete", id: "b" }, async () => {}, () => {});
    });
    expect(vault.frames.at(-1)).toEqual(["Alpha"]);
    await act(async () => vault.respond([notes[0]]));
    expect(vault.frames.at(-1)).toEqual(["Alpha"]);
    expect(vault.overlays.at(-1)).toBe(EMPTY_OVERLAY);
    expect(vault.frames.slice(vault.frames.findIndex((f) => f.length === 1)).every((f) => f.length === 1)).toBe(
      true,
    );
  });

  it("rolls back when the request throws, reports the error, and does not refresh", async () => {
    const vault = await mount();
    const onError = vi.fn();
    let refuse!: (error: Error) => void;
    await act(async () => {
      vault.run(
        { kind: "rename", id: "a", title: "Apex" },
        () => new Promise<void>((_, reject) => (refuse = reject)),
        onError,
      );
    });
    expect(vault.frames.at(-1)).toEqual(["Apex", "Beta"]);

    const refusal = new Error("Another note is already called “Apex”");
    await act(async () => refuse(refusal));
    expect(onError).toHaveBeenCalledWith(refusal);
    expect(vault.refresh).not.toHaveBeenCalled();
    expect(vault.frames.at(-1)).toEqual(["Alpha", "Beta"]);
    expect(vault.overlays.at(-1)).toBe(EMPTY_OVERLAY);
  });

  it("rolls a refused change back once the changes in flight with it settle", async () => {
    const vault = await mount();
    let answerDelete!: () => void;
    let refuseRename!: (error: Error) => void;
    await act(async () => {
      vault.run(
        { kind: "delete", id: "b" },
        () => new Promise<void>((resolve) => (answerDelete = resolve)),
        () => {},
      );
      vault.run(
        { kind: "rename", id: "a", title: "Apex" },
        () => new Promise<void>((_, reject) => (refuseRename = reject)),
        () => {},
      );
    });
    expect(vault.frames.at(-1)).toEqual(["Apex"]);

    // React keeps the optimistic updates of overlapping actions until all of
    // them settle, so the refused rename drops together with the delete.
    await act(async () => refuseRename(new Error("locked")));
    await act(async () => answerDelete());
    await act(async () => vault.respond([notes[0]]));
    expect(vault.frames.at(-1)).toEqual(["Alpha"]);
    expect(vault.overlays.at(-1)).toBe(EMPTY_OVERLAY);
  });
});
