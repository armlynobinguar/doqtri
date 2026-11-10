import { describe, expect, it } from "vitest";
import {
  dropNote,
  EMPTY_NOTE_STORE,
  hostPath,
  keepEditorCopy,
  notePathId,
  refreshVerdict,
  seedNotes,
  switchVia,
  takeRename,
  takeRow,
  trustHolds,
  type NoteStore,
} from "@/lib/note-store";
import type { Doc } from "@/lib/types";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";

function doc(id: string, markdown: string, version: number, title = id.slice(0, 1)): Doc {
  return { id, title, markdown, version, mindmap: null, mindmapStale: false };
}

function seeded(docs: Doc[], loadedAt = 100, workspaceId = "w1"): NoteStore {
  return seedNotes(EMPTY_NOTE_STORE, { workspaceId, loadedAt, docs });
}

function find(store: NoteStore, id: string): Doc | undefined {
  return store.docs.find((d) => d.id === id);
}

describe("seedNotes", () => {
  it("takes the first snapshot whole", () => {
    const store = seeded([doc(A, "a", 1), doc(B, "b", 1)]);
    expect(store.workspaceId).toBe("w1");
    expect(store.docs.map((d) => d.id)).toEqual([A, B]);
  });

  it("replaces the copy, drafts included, for another workspace", () => {
    const store = keepEditorCopy(seeded([doc(A, "a", 1)]), A, { saved: "a", version: 1, text: "a typed" });
    const next = seedNotes(store, { workspaceId: "w2", loadedAt: 50, docs: [doc(C, "c", 1)] });
    expect(next.docs.map((d) => d.id)).toEqual([C]);
    expect(next.drafts.size).toBe(0);
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

  it("never lets a snapshot overwrite text this client holds at a newer version", () => {
    const saved = keepEditorCopy(seeded([doc(A, "a", 1)]), A, { saved: "a mine", version: 2, text: "a mine" });
    // Read on the server before that save landed, but delivered after it.
    const next = seedNotes(saved, { workspaceId: "w1", loadedAt: 200, docs: [doc(A, "a", 1, "Renamed")] });
    expect(find(next, A)).toMatchObject({ markdown: "a mine", version: 2, title: "Renamed" });
  });

  it("keeps a note with unsaved text as it was, even under a newer version", () => {
    const store = keepEditorCopy(seeded([doc(A, "a", 1)]), A, { saved: "a", version: 1, text: "a typed" });
    const next = seedNotes(store, { workspaceId: "w1", loadedAt: 200, docs: [doc(A, "a theirs", 2)] });
    expect(find(next, A)).toMatchObject({ markdown: "a", version: 1 });
    expect(next.drafts.get(A)).toBe("a typed");
  });

  it("drops the draft of a note the server no longer lists", () => {
    const store = keepEditorCopy(seeded([doc(A, "a", 1), doc(B, "b", 1)]), A, { saved: "a", version: 1, text: "x" });
    const next = seedNotes(store, { workspaceId: "w1", loadedAt: 200, docs: [doc(B, "b", 1)] });
    expect(next.drafts.has(A)).toBe(false);
  });
});

describe("keepEditorCopy", () => {
  it("keeps the editor's saved text and version", () => {
    const next = keepEditorCopy(seeded([doc(A, "a", 1)]), A, { saved: "a edited", version: 2, text: "a edited" });
    expect(find(next, A)).toMatchObject({ markdown: "a edited", version: 2 });
    expect(next.drafts.has(A)).toBe(false);
  });

  it("keeps unsaved text as a draft over the saved text it was typed on", () => {
    const next = keepEditorCopy(seeded([doc(A, "a", 1)]), A, { saved: "a", version: 1, text: "a typed" });
    expect(find(next, A)).toMatchObject({ markdown: "a", version: 1 });
    expect(next.drafts.get(A)).toBe("a typed");
  });

  it("does not take an older copy over a newer one, unless it carries unsaved text", () => {
    const store = seeded([doc(A, "a3", 3)]);
    expect(keepEditorCopy(store, A, { saved: "a2", version: 2, text: "a2" })).toBe(store);
    const typed = keepEditorCopy(store, A, { saved: "a2", version: 2, text: "a2 typed" });
    // The draft stays on the version it was typed over, so its save is refused.
    expect(find(typed, A)).toMatchObject({ markdown: "a2", version: 2 });
    expect(typed.drafts.get(A)).toBe("a2 typed");
  });

  it("clears a draft once the text is saved", () => {
    const store = keepEditorCopy(seeded([doc(A, "a", 1)]), A, { saved: "a", version: 1, text: "a typed" });
    const next = keepEditorCopy(store, A, { saved: "a typed", version: 2, text: "a typed" });
    expect(next.drafts.has(A)).toBe(false);
    expect(find(next, A)).toMatchObject({ markdown: "a typed", version: 2 });
  });

  it("ignores a note no longer in the copy", () => {
    const store = seeded([doc(A, "a", 1)]);
    expect(keepEditorCopy(store, B, { saved: "b", version: 1, text: "b" })).toBe(store);
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

  it("leaves a note with unsaved text on the version it was typed over", () => {
    const store = keepEditorCopy(seeded([doc(A, "a", 1)]), A, { saved: "a", version: 1, text: "a typed" });
    expect(takeRow(store, A, row)).toBe(store);
  });
});

describe("refreshVerdict", () => {
  it("keeps the copy when the row is no newer", () => {
    expect(refreshVerdict({ version: 2, unsaved: false }, { version: 2 })).toBe("keep");
    expect(refreshVerdict({ version: 2, unsaved: true }, { version: 1 })).toBe("keep");
  });

  it("adopts a newer row when nothing is typed over the copy", () => {
    expect(refreshVerdict({ version: 1, unsaved: false }, { version: 2 })).toBe("adopt");
  });

  it("is a conflict when unsaved text was typed over an older copy", () => {
    expect(refreshVerdict({ version: 1, unsaved: true }, { version: 2 })).toBe("conflict");
  });
});

describe("takeRename and dropNote", () => {
  it("takes the new title, and the text the rename wrote when it is newer", () => {
    const next = takeRename(seeded([doc(A, "# A", 1, "A")]), A, { title: "Z", markdown: "# Z", version: 2 });
    expect(find(next, A)).toMatchObject({ title: "Z", markdown: "# Z", version: 2 });
  });

  it("keeps newer local text and drafts, taking only the title", () => {
    const store = keepEditorCopy(seeded([doc(A, "# A", 1, "A")]), A, { saved: "# A", version: 1, text: "# A typed" });
    const next = takeRename(store, A, { title: "Z", markdown: "# Z", version: 2 });
    expect(find(next, A)).toMatchObject({ title: "Z", markdown: "# A", version: 1 });
  });

  it("drops a deleted note and its draft", () => {
    const store = keepEditorCopy(seeded([doc(A, "a", 1), doc(B, "b", 1)]), A, { saved: "a", version: 1, text: "x" });
    const next = dropNote(store, A);
    expect(next.docs.map((d) => d.id)).toEqual([B]);
    expect(next.drafts.has(A)).toBe(false);
    expect(dropNote(next, A)).toBe(next);
  });
});

describe("notePathId", () => {
  it("names the note of a note page only", () => {
    expect(notePathId(`/vault/${A}`)).toBe(A);
    expect(notePathId(`/vault/${A}/mindmap`)).toBeNull();
    expect(notePathId("/vault/graph")).toBeNull();
    expect(notePathId("/vault")).toBeNull();
  });
});

describe("host trust", () => {
  const a = `/vault/${A}`;
  const b = `/vault/${B}`;
  const c = `/vault/${C}`;

  it("follows a pushed URL before the router reports it", () => {
    const trust = { id: B, path: b, via: switchVia(null, a) };
    expect(hostPath(trust, a)).toBe(b);
    expect(hostPath(trust, b)).toBe(b);
    expect(trustHolds(trust, a)).toBe(true);
  });

  it("chains quick switches, so a path the router passes through never shows", () => {
    const first = { id: B, path: b, via: switchVia(null, a) };
    const second = { id: C, path: c, via: switchVia(first, a) };
    expect(second.via).toEqual([a, b]);
    expect(hostPath(second, a)).toBe(c);
    expect(hostPath(second, b)).toBe(c);
  });

  it("gives way to a navigation elsewhere", () => {
    const trust = { id: B, path: b, via: [a] };
    expect(hostPath(trust, "/vault/graph")).toBe("/vault/graph");
    expect(trustHolds(trust, "/vault/graph")).toBe(false);
  });
});
