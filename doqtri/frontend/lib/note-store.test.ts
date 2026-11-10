import { describe, expect, it } from "vitest";
import {
  dropNote,
  EMPTY_HOST,
  EMPTY_NOTE_STORE,
  hostShows,
  hostStep,
  keepEditorCopy,
  notePathId,
  refreshVerdict,
  seedNotes,
  takeRename,
  takeRow,
  type HostEvent,
  type HostState,
  type NoteStore,
} from "@/lib/note-store";
import type { Doc } from "@/lib/types";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const pathA = `/vault/${A}`;
const pathB = `/vault/${B}`;
const pathC = `/vault/${C}`;

function doc(id: string, markdown: string, version: number, title = id.slice(0, 1)): Doc {
  return { id, title, markdown, version, mindmap: null, mindmapStale: false };
}

function seeded(docs: Doc[], loadedAt = 100, workspaceId = "w1"): NoteStore {
  return seedNotes(EMPTY_NOTE_STORE, { workspaceId, loadedAt, docs });
}

function find(store: NoteStore, id: string): Doc | undefined {
  return store.docs.find((d) => d.id === id);
}

const noMap = { mindmap: null, mindmapStale: false };

describe("seedNotes", () => {
  it("takes the first snapshot whole", () => {
    const store = seeded([doc(A, "a", 1), doc(B, "b", 1)]);
    expect(store.workspaceId).toBe("w1");
    expect(store.docs.map((d) => d.id)).toEqual([A, B]);
  });

  it("replaces the copy, unsaved text included, for another workspace", () => {
    const store = keepEditorCopy(seeded([doc(A, "a", 1)]), A, {
      saved: "a",
      version: 1,
      ...noMap,
      unsaved: { text: "a typed", version: 1 },
    });
    const next = seedNotes(store, { workspaceId: "w2", loadedAt: 50, docs: [doc(C, "c", 1)] });
    expect(next.docs.map((d) => d.id)).toEqual([C]);
    expect(next.unsaved.size).toBe(0);
  });

  it("ignores a snapshot older than one already taken in", () => {
    const store = seeded([doc(A, "a2", 2)], 200);
    expect(seedNotes(store, { workspaceId: "w1", loadedAt: 100, docs: [doc(A, "a1", 1)] })).toBe(store);
  });

  it("lets a newer snapshot win, adding and removing notes", () => {
    const store = seeded([doc(A, "a", 1), doc(B, "b", 1)]);
    const next = seedNotes(store, { workspaceId: "w1", loadedAt: 200, docs: [doc(A, "a2", 2), doc(C, "c", 1)] });
    expect(next.docs.map((d) => [d.id, d.markdown])).toEqual([
      [A, "a2"],
      [C, "c"],
    ]);
  });

  it("never lets a snapshot overwrite text this client saved at a newer version", () => {
    const saved = keepEditorCopy(seeded([doc(A, "a", 1)]), A, { saved: "a mine", version: 2, ...noMap });
    // Read on the server before that save landed, but delivered after it.
    const next = seedNotes(saved, { workspaceId: "w1", loadedAt: 200, docs: [doc(A, "a", 1, "Renamed")] });
    expect(find(next, A)).toMatchObject({ markdown: "a mine", version: 2, title: "Renamed" });
  });

  it("keeps unsaved text with its own version while the saved copy moves on", () => {
    const store = keepEditorCopy(seeded([doc(A, "a", 1)]), A, {
      saved: "a",
      version: 1,
      ...noMap,
      unsaved: { text: "a typed", version: 1 },
    });
    const next = seedNotes(store, { workspaceId: "w1", loadedAt: 200, docs: [doc(A, "a theirs", 2)] });
    expect(find(next, A)).toMatchObject({ markdown: "a theirs", version: 2 });
    expect(next.unsaved.get(A)).toEqual({ text: "a typed", version: 1 });
  });
});

describe("keepEditorCopy", () => {
  it("keeps the saved text, version and map", () => {
    const map = { version: 1, root: { id: "r", label: "A", kind: "root", children: [] } } as unknown as Doc["mindmap"];
    const next = keepEditorCopy(seeded([doc(A, "a", 1)]), A, {
      saved: "a edited",
      version: 2,
      mindmap: map,
      mindmapStale: true,
    });
    expect(find(next, A)).toMatchObject({ markdown: "a edited", version: 2, mindmap: map, mindmapStale: true });
    expect(next.unsaved.has(A)).toBe(false);
  });

  it("keeps text only when the editor says its last save failed", () => {
    const next = keepEditorCopy(seeded([doc(A, "a", 1)]), A, {
      saved: "a",
      version: 1,
      ...noMap,
      unsaved: { text: "a typed", version: 1 },
    });
    expect(find(next, A)).toMatchObject({ markdown: "a", version: 1 });
    expect(next.unsaved.get(A)).toEqual({ text: "a typed", version: 1 });
    // Reopened on it and saved it: gone.
    const saved = keepEditorCopy(next, A, { saved: "a typed", version: 2, ...noMap, restored: next.unsaved.get(A) });
    expect(saved.unsaved.has(A)).toBe(false);
  });

  it("never drops unsaved text the closing editor did not open on", () => {
    const left = { text: "a typed", version: 1 };
    // An earlier editor's last save failed after this one had opened.
    const store = keepEditorCopy(seeded([doc(A, "a", 1)]), A, { saved: "a", version: 1, ...noMap, unsaved: left });
    const kept = keepEditorCopy(store, A, { saved: "a", version: 1, ...noMap });
    expect(kept.unsaved.get(A)).toBe(left);
    // The editor that opened on it, and saved it, drops it.
    const saved = keepEditorCopy(store, A, { saved: "a typed", version: 2, ...noMap, restored: left });
    expect(saved.unsaved.has(A)).toBe(false);
  });

  it("does not take an older copy over a newer one", () => {
    const store = seeded([doc(A, "a3", 3)]);
    expect(find(keepEditorCopy(store, A, { saved: "a2", version: 2, ...noMap }), A)).toMatchObject({
      markdown: "a3",
      version: 3,
    });
  });

  it("ignores a note no longer in the copy", () => {
    const store = seeded([doc(A, "a", 1)]);
    expect(keepEditorCopy(store, B, { saved: "b", version: 1, ...noMap })).toBe(store);
  });
});

describe("takeRow", () => {
  const row = { markdown: "a2", version: 2, mindmap: null, mindmapStale: true };

  it("takes a row at least as new as the copy", () => {
    expect(find(takeRow(seeded([doc(A, "a", 1)]), A, row), A)).toMatchObject(row);
  });

  it("ignores an older row", () => {
    const store = seeded([doc(A, "a3", 3)]);
    expect(takeRow(store, A, row)).toBe(store);
  });
});

describe("refreshVerdict", () => {
  it("keeps the copy when the row is no newer", () => {
    expect(refreshVerdict({ version: 2, text: "a", unsaved: false }, { version: 2, markdown: "a" })).toBe("keep");
    expect(refreshVerdict({ version: 2, text: "x", unsaved: true }, { version: 1, markdown: "a" })).toBe("keep");
  });

  it("adopts a newer row when nothing unsaved is held, or the row holds that very text", () => {
    expect(refreshVerdict({ version: 1, text: "a", unsaved: false }, { version: 2, markdown: "b" })).toBe("adopt");
    expect(refreshVerdict({ version: 1, text: "b", unsaved: true }, { version: 2, markdown: "b" })).toBe("adopt");
  });

  it("is a conflict when text a failed save left sits over an older copy", () => {
    expect(refreshVerdict({ version: 1, text: "x", unsaved: true }, { version: 2, markdown: "b" })).toBe("conflict");
  });
});

describe("takeRename and dropNote", () => {
  it("takes the new title, and the text the rename wrote when it is newer", () => {
    const next = takeRename(seeded([doc(A, "# A", 1, "A")]), A, { title: "Z", markdown: "# Z", version: 2 });
    expect(find(next, A)).toMatchObject({ title: "Z", markdown: "# Z", version: 2 });
  });

  it("takes only the title when the copy is newer", () => {
    const next = takeRename(seeded([doc(A, "# A", 3, "A")]), A, { title: "Z", markdown: "# Z", version: 2 });
    expect(find(next, A)).toMatchObject({ title: "Z", markdown: "# A", version: 3 });
  });

  it("drops a deleted note and its unsaved text", () => {
    const store = keepEditorCopy(seeded([doc(A, "a", 1), doc(B, "b", 1)]), A, {
      saved: "a",
      version: 1,
      ...noMap,
      unsaved: { text: "x", version: 1 },
    });
    const next = dropNote(store, A);
    expect(next.docs.map((d) => d.id)).toEqual([B]);
    expect(next.unsaved.has(A)).toBe(false);
    expect(dropNote(next, A)).toBe(next);
  });
});

describe("notePathId", () => {
  it("names the note of a note page only", () => {
    expect(notePathId(pathA)).toBe(A);
    expect(notePathId(`${pathA}/mindmap`)).toBeNull();
    expect(notePathId("/vault/graph")).toBeNull();
    expect(notePathId("/vault")).toBeNull();
  });
});

/** Runs events through the host, as the provider does. */
function run(events: HostEvent[], from: HostState = EMPTY_HOST): HostState {
  return events.reduce(hostStep, from);
}

describe("the note host", () => {
  const loadedA = run([
    { type: "router", pathname: pathA, location: pathA },
    { type: "seed", id: A, location: pathA, fresh: true },
  ]);

  it("shows a server-rendered note once its snapshot is in, without reading it again", () => {
    expect(hostShows(EMPTY_HOST, pathA)).toBeNull();
    expect(hostShows(loadedA, pathA)).toBe(A);
    expect(loadedA.trusted).toEqual({ id: A, recheck: false });
  });

  it("reads again a note whose page came back from the router's cache, older than the copy", () => {
    const state = run([{ type: "seed", id: A, location: pathA, fresh: false }]);
    expect(state.trusted).toEqual({ id: A, recheck: true });
  });

  it("switches at once on open, while the router still reports the old note", () => {
    const state = hostStep(loadedA, { type: "open", id: B });
    expect(hostShows(state, pathA)).toBe(B);
    expect(state.trusted).toEqual({ id: B, recheck: true });
    // The router catches up, and the pushed URL is no longer needed.
    const caughtUp = hostStep(state, { type: "router", pathname: pathB, location: pathB });
    expect(caughtUp.pushed).toBeNull();
    expect(hostShows(caughtUp, pathB)).toBe(B);
  });

  it("never shows a note the router passes through on quick switches", () => {
    const state = run([
      { type: "open", id: B },
      { type: "open", id: C },
      // The router reports the first push while the browser is at the second.
      { type: "router", pathname: pathB, location: pathC },
    ], loadedA);
    expect(hostShows(state, pathB)).toBe(C);
    expect(hostShows(hostStep(state, { type: "router", pathname: pathC, location: pathC }), pathC)).toBe(C);
  });

  it("ignores a refresh's snapshot for the note it was started on, after a switch", () => {
    const state = run([
      { type: "open", id: B },
      { type: "seed", id: A, location: pathB, fresh: true },
    ], loadedA);
    expect(hostShows(state, pathA)).toBe(B);
  });

  it("follows back and forward between notes at once", () => {
    const onB = run([
      { type: "open", id: B },
      { type: "router", pathname: pathB, location: pathB },
    ], loadedA);
    const back = hostStep(onB, { type: "popstate", id: A, fromNote: true });
    expect(hostShows(back, pathB)).toBe(A);
  });

  it("from another route, waits for the router before showing the note", () => {
    const onGraph = hostStep(loadedA, { type: "router", pathname: "/vault/graph", location: "/vault/graph" });
    expect(onGraph.trusted).toBeNull();
    const back = hostStep(onGraph, { type: "popstate", id: A, fromNote: false });
    expect(hostShows(back, "/vault/graph")).toBeNull();
    expect(hostShows(hostStep(back, { type: "router", pathname: pathA, location: pathA }), pathA)).toBe(A);
  });

  it("keeps showing the note until the router reaches a page that is not one", () => {
    // Back to the graph: nothing changes on popstate, so no loader in between.
    expect(hostShows(loadedA, pathA)).toBe(A);
    const there = hostStep(loadedA, { type: "router", pathname: "/vault/graph", location: "/vault/graph" });
    expect(hostShows(there, "/vault/graph")).toBeNull();
  });

  it("makes a later server render of a note wait for its own snapshot", () => {
    const state = run([
      { type: "open", id: B },
      { type: "router", pathname: "/vault/graph", location: "/vault/graph" },
      // A server navigation back to B: the copy is not trusted until B's
      // snapshot is in, so the editor never starts on older text.
      { type: "router", pathname: pathB, location: pathB },
    ], loadedA);
    expect(hostShows(state, pathB)).toBeNull();
    expect(hostShows(hostStep(state, { type: "seed", id: B, location: pathB, fresh: true }), pathB)).toBe(B);
  });
});
