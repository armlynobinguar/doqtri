import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocMindmap } from "@/lib/mindmap-types";
import type { Doc } from "@/lib/types";
import {
  buildHackathonSnapshot,
  HackathonSnapshotError,
  HACKATHON_LIMITS,
  serializeGlobalMindmap,
  validateHackathonSnapshot,
  withMindmapUrl,
  type HackathonNote,
  type HackathonSnapshot,
} from "./qdit-hackathon";

const A = "a0000000-0000-4000-8000-000000000001";
const B = "b0000000-0000-4000-8000-000000000002";
const C = "c0000000-0000-4000-8000-000000000003";
const WS = "e0000000-0000-4000-8000-00000000000e";
const SNAP = "f0000000-0000-4000-8000-00000000000f";

const map = (title: string, ...labels: string[]): DocMindmap => ({
  version: 1,
  root: {
    id: "root",
    label: title,
    kind: "root",
    children: labels.map((label, i) => ({ id: `c${i}`, label, kind: "theme", summary: "hover", children: [] })),
  },
  concepts: labels,
});

const doc = (id: string, title: string, ...labels: string[]): Doc => ({
  id,
  title,
  markdown: `# ${title}\n`,
  mindmap: map(title, ...labels),
});

const note = (docId: string, extra: Partial<HackathonNote> = {}): HackathonNote => ({
  doc_id: docId,
  title: "Plan",
  markdown: "# Plan\n",
  mindmap: null,
  created_at: "2026-11-20T09:00:00.000Z",
  updated_at: "2026-11-20T10:00:00.000Z",
  version: null,
  source: null,
  ...extra,
});

const snapshot = (extra: Partial<HackathonSnapshot> = {}): HackathonSnapshot => ({
  hackathon_slug: "stellar-build-2026",
  snapshot_id: SNAP,
  workspace_id: WS,
  generated_at: "2026-11-20T15:04:05.000Z",
  notes: [note(A)],
  global_mindmap: {
    nodes: [{ id: `doc:${A}`, label: "Plan", kind: "document", depth: 0, doc_ids: [A] }],
    links: [],
  },
  ...extra,
});

function refusal(fn: () => unknown): HackathonSnapshotError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HackathonSnapshotError);
    return error as HackathonSnapshotError;
  }
  throw new Error("expected a HackathonSnapshotError");
}

describe("serializeGlobalMindmap", () => {
  const docs = [doc(A, "Payroll", "Escrow", "Budget"), doc(B, "Escrow notes", "Escrow", "Payroll"), doc(C, "Lonely")];

  it("sends only the contract's fields, with the notes that reach each node", () => {
    const { nodes, links } = serializeGlobalMindmap(docs);
    for (const node of nodes) expect(Object.keys(node).sort()).toEqual(["depth", "doc_ids", "id", "kind", "label"]);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

    // A concept two notes name is a hub reached by both.
    expect(byId["concept:escrow"]).toEqual({ id: "concept:escrow", label: "Escrow", kind: "hub", depth: 1, doc_ids: [A, B] });
    expect(byId["concept:budget"].doc_ids).toEqual([A]);
    // B names A's title, so it points at A's document node: A is reached by itself and by B.
    expect(byId[`doc:${A}`]).toEqual({ id: `doc:${A}`, label: "Payroll", kind: "document", depth: 0, doc_ids: [A, B] });
    expect(byId[`doc:${B}`].doc_ids).toEqual([B]);
    expect(byId[`doc:${C}`].doc_ids).toEqual([C]);
    expect(links).toContainEqual({ source: `doc:${B}`, target: `doc:${A}` });
  });

  it("gives the same output whatever order the notes come in", () => {
    const first = JSON.stringify(serializeGlobalMindmap(docs));
    expect(JSON.stringify(serializeGlobalMindmap([...docs].reverse()))).toBe(first);
    expect(JSON.stringify(serializeGlobalMindmap([docs[1], docs[2], docs[0]]))).toBe(first);
    const { nodes, links } = serializeGlobalMindmap(docs);
    expect(nodes.map((n) => n.id)).toEqual([...nodes.map((n) => n.id)].sort());
    const keys = links.map((l) => `${l.source}\u0000${l.target}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("maps ids over 128 characters to stable short ids and rewrites the links", () => {
    const long = "x".repeat(200);
    const once = serializeGlobalMindmap([doc(A, "Plan", long)]);
    const again = serializeGlobalMindmap([doc(A, "Plan", long)]);
    const concept = once.nodes.find((n) => n.kind === "concept")!;
    expect(concept.id).toMatch(/^c:[0-9a-f]{16}$/);
    expect(concept.label).toBe(long);
    expect(again.nodes.find((n) => n.kind === "concept")!.id).toBe(concept.id);
    expect(once.links).toEqual([{ source: `doc:${A}`, target: concept.id }]);
    expect(once.nodes.every((n) => n.id.length <= HACKATHON_LIMITS.nodeIdChars)).toBe(true);
  });

  it("cuts labels over 300 code points to 299 plus an ellipsis", () => {
    const long = "🙂".repeat(400);
    const exact = "é".repeat(300);
    const { nodes } = serializeGlobalMindmap([doc(A, "Plan", long, exact)]);
    const cut = nodes.find((n) => n.label.startsWith("🙂"))!;
    expect([...cut.label]).toHaveLength(300);
    expect(cut.label).toBe(`${"🙂".repeat(299)}…`);
    expect(nodes.find((n) => n.label.startsWith("é"))!.label).toBe(exact);
    expect(() =>
      validateHackathonSnapshot(snapshot({ notes: [note(A)], global_mindmap: serializeGlobalMindmap([doc(A, "Plan", long)]) })),
    ).not.toThrow();
  });

  it("passes validation for the notes it was built from", () => {
    const global = serializeGlobalMindmap(docs);
    const notes = docs.map((d) => note(d.id, { title: d.title }));
    expect(() => validateHackathonSnapshot(snapshot({ notes, global_mindmap: global }))).not.toThrow();
  });

  describe("hidden nodes (DOQ-54)", () => {
    const all = serializeGlobalMindmap(docs);

    it("leaves out each hidden node and every link touching it, and nothing else", () => {
      const hidden = new Set(["concept:escrow", `doc:${C}`]);
      const { nodes, links } = serializeGlobalMindmap(docs, hidden);
      expect(nodes.map((n) => n.id)).toEqual(all.nodes.map((n) => n.id).filter((id) => !hidden.has(id)));
      expect(links).toEqual(all.links.filter((l) => !hidden.has(l.source) && !hidden.has(l.target)));
      expect(links.length).toBeLessThan(all.links.length);
      // Unhidden nodes are unchanged, doc_ids included.
      const byId = Object.fromEntries(all.nodes.map((n) => [n.id, n]));
      for (const node of nodes) expect(node).toEqual(byId[node.id]);
    });

    it("matches hidden ids before they are shortened, as the style keys them", () => {
      const long = "x".repeat(200);
      const shown = serializeGlobalMindmap([doc(A, "Plan", long)]);
      const concept = shown.nodes.find((n) => n.kind === "concept")!;
      expect(concept.id).toMatch(/^c:/);
      const hidden = serializeGlobalMindmap([doc(A, "Plan", long)], new Set([`concept:${long}`]));
      expect(hidden.nodes.map((n) => n.id)).toEqual([`doc:${A}`]);
      expect(hidden.links).toEqual([]);
    });

    it("is stable, and still passes every contract check and count", () => {
      const hidden = new Set(["concept:budget"]);
      const once = JSON.stringify(serializeGlobalMindmap(docs, hidden));
      expect(JSON.stringify(serializeGlobalMindmap([...docs].reverse(), hidden))).toBe(once);
      const notes = docs.map((d) => note(d.id, { title: d.title }));
      expect(() => validateHackathonSnapshot(snapshot({ notes, global_mindmap: serializeGlobalMindmap(docs, hidden) }))).not.toThrow();
    });

    it("hides nothing for an empty set or an id that is not on the map", () => {
      expect(serializeGlobalMindmap(docs, new Set())).toEqual(all);
      expect(serializeGlobalMindmap(docs, new Set(["concept:nowhere"]))).toEqual(all);
    });
  });
});

describe("validateHackathonSnapshot", () => {
  it("returns the exact JSON to send", () => {
    const value = snapshot();
    expect(validateHackathonSnapshot(value)).toBe(JSON.stringify(value));
  });

  it.each([
    ["", "hackathon_slug"],
    ["Stellar", "hackathon_slug"],
    ["stellar_build", "hackathon_slug"],
    ["a".repeat(65), "hackathon_slug"],
  ])("refuses the slug %j", (slug, field) => {
    expect(refusal(() => validateHackathonSnapshot(snapshot({ hackathon_slug: slug }))).field).toBe(field);
  });

  it("accepts slugs of 1 and 64 characters", () => {
    expect(() => validateHackathonSnapshot(snapshot({ hackathon_slug: "a" }))).not.toThrow();
    expect(() => validateHackathonSnapshot(snapshot({ hackathon_slug: "a-1".padEnd(64, "z") }))).not.toThrow();
  });

  it("names each limit's field", () => {
    const cases: [string, Partial<HackathonSnapshot>][] = [
      ["notes", { notes: Array.from({ length: 201 }, (_, i) => note(`a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`)), global_mindmap: { nodes: [], links: [] } }],
      ["notes[0].title", { notes: [note(A, { title: "t".repeat(301) })] }],
      ["notes[0].markdown", { notes: [note(A, { markdown: "é".repeat(51_201) })] }],
      ["notes[0].mindmap", { notes: [note(A, { mindmap: { blob: "m".repeat(65_536) } })] }],
      ["global_mindmap.nodes", { global_mindmap: { nodes: Array.from({ length: 5_001 }, (_, i) => ({ id: `n${i}`, label: "", kind: "concept", depth: 1, doc_ids: [] })), links: [] } }],
      ["global_mindmap.links", { global_mindmap: { nodes: [{ id: "n", label: "", kind: "concept", depth: 1, doc_ids: [] }], links: Array.from({ length: 20_001 }, () => ({ source: "n", target: "n" })) } }],
      ["global_mindmap.nodes[0].id", { global_mindmap: { nodes: [{ id: "i".repeat(129), label: "", kind: "concept", depth: 1, doc_ids: [] }], links: [] } }],
      ["global_mindmap.nodes[0].label", { global_mindmap: { nodes: [{ id: "n", label: "l".repeat(301), kind: "concept", depth: 1, doc_ids: [] }], links: [] } }],
      ["global_mindmap.nodes[0].kind", { global_mindmap: { nodes: [{ id: "n", label: "", kind: "k".repeat(33), depth: 1, doc_ids: [] }], links: [] } }],
    ];
    for (const [field, extra] of cases) {
      const error = refusal(() => validateHackathonSnapshot(snapshot(extra)));
      expect(error.field, field).toBe(field);
      expect(error.problem, field).toMatch(/too_many|too_long/);
    }
  });

  it("counts title, label, kind and id lengths in code points", () => {
    // Each emoji is two UTF-16 units but one code point.
    const emoji = (n: number) => "🙂".repeat(n);
    expect(() => validateHackathonSnapshot(snapshot({ notes: [note(A, { title: emoji(300) })] }))).not.toThrow();
    expect(refusal(() => validateHackathonSnapshot(snapshot({ notes: [note(A, { title: emoji(301) })] })))).toMatchObject({
      field: "notes[0].title",
      actual: 301,
    });
    const node = (extra: Record<string, unknown>) =>
      snapshot({ global_mindmap: { nodes: [{ id: "n", label: "", kind: "concept", depth: 1, doc_ids: [], ...extra }], links: [] } });
    expect(() => validateHackathonSnapshot(node({ label: emoji(300), kind: emoji(32), id: emoji(128) }))).not.toThrow();
    expect(refusal(() => validateHackathonSnapshot(node({ label: emoji(301) }))).field).toBe("global_mindmap.nodes[0].label");
    expect(refusal(() => validateHackathonSnapshot(node({ kind: emoji(33) }))).field).toBe("global_mindmap.nodes[0].kind");
    expect(refusal(() => validateHackathonSnapshot(node({ id: emoji(129) }))).field).toBe("global_mindmap.nodes[0].id");
  });

  it("counts markdown in UTF-8 bytes, not characters", () => {
    // 51,200 two-byte characters are exactly 100 KiB.
    expect(() => validateHackathonSnapshot(snapshot({ notes: [note(A, { markdown: "é".repeat(51_200) })] }))).not.toThrow();
  });

  it("refuses a body over 2 MiB as `body`", () => {
    const notes = Array.from({ length: 21 }, (_, i) =>
      note(`a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`, { markdown: "m".repeat(100 * 1024) }),
    );
    const error = refusal(() => validateHackathonSnapshot(snapshot({ notes, global_mindmap: { nodes: [], links: [] } })));
    expect(error.field).toBe("body");
    expect(error.actual).toBeGreaterThan(HACKATHON_LIMITS.bodyBytes);
  });

  it("refuses fields the contract does not list", () => {
    const withHref = snapshot();
    (withHref.global_mindmap.nodes[0] as Record<string, unknown>).href = "/vault/x";
    expect(refusal(() => validateHackathonSnapshot(withHref)).field).toBe("global_mindmap.nodes[0].href");
    expect(refusal(() => validateHackathonSnapshot({ ...snapshot(), extra: 1 } as HackathonSnapshot)).field).toBe("extra");
    const noSource = snapshot();
    delete (noSource.notes[0] as Partial<HackathonNote>).source;
    expect(refusal(() => validateHackathonSnapshot(noSource)).field).toBe("notes[0].source");
  });

  it("checks uniqueness and references", () => {
    expect(refusal(() => validateHackathonSnapshot(snapshot({ notes: [note(A), note(A)] }))).problem).toBe("duplicate");
    const twice = snapshot();
    twice.global_mindmap.nodes.push({ ...twice.global_mindmap.nodes[0] });
    expect(refusal(() => validateHackathonSnapshot(twice)).field).toBe("global_mindmap.nodes[1].id");
    const stranger = snapshot();
    stranger.global_mindmap.nodes[0].doc_ids = [B];
    expect(refusal(() => validateHackathonSnapshot(stranger))).toMatchObject({
      field: "global_mindmap.nodes[0].doc_ids[0]",
      problem: "unknown_reference",
    });
    const dangling = snapshot();
    dangling.global_mindmap.links = [{ source: `doc:${A}`, target: "concept:nowhere" }];
    expect(refusal(() => validateHackathonSnapshot(dangling)).field).toBe("global_mindmap.links[0].target");
  });

  it("checks the scalar fields", () => {
    expect(refusal(() => validateHackathonSnapshot(snapshot({ notes: [note(A, { version: 0 })] }))).field).toBe("notes[0].version");
    expect(() => validateHackathonSnapshot(snapshot({ notes: [note(A, { version: 1 })] }))).not.toThrow();
    expect(() => validateHackathonSnapshot(snapshot({ notes: [note(A, { title: "" })] }))).not.toThrow();
    expect(refusal(() => validateHackathonSnapshot(snapshot({ snapshot_id: SNAP.toUpperCase() }))).field).toBe("snapshot_id");
    expect(refusal(() => validateHackathonSnapshot(snapshot({ notes: [note(A, { created_at: "yesterday" })] }))).field).toBe(
      "notes[0].created_at",
    );
    expect(
      refusal(() => validateHackathonSnapshot(snapshot({ notes: [note(A, { source: "upload" as HackathonNote["source"] })] }))).field,
    ).toBe("notes[0].source");
    const deep = snapshot();
    deep.global_mindmap.nodes[0].depth = -1;
    expect(refusal(() => validateHackathonSnapshot(deep)).field).toBe("global_mindmap.nodes[0].depth");
  });
});

describe("mindmap_url (WP-4.7, DOQ-53, QDIT-66)", () => {
  const URL_OK = "https://www.doqtri.xyz/m/AbCdEfGhIjKlMnOpQrStUvWxYz012345";

  it("is optional: a snapshot without it is valid, as before", () => {
    const value = snapshot();
    expect("mindmap_url" in value).toBe(false);
    expect(() => validateHackathonSnapshot(value)).not.toThrow();
  });

  it("is a top-level key when present, sent as is", () => {
    const value = snapshot({ mindmap_url: URL_OK });
    expect(JSON.parse(validateHackathonSnapshot(value)).mindmap_url).toBe(URL_OK);
  });

  it.each([
    ["http", "http://www.doqtri.xyz/m/AbCdEfGhIjKlMnOpQrStUvWxYz012345"],
    ["a query", `${URL_OK}?x=1`],
    ["a fragment", `${URL_OK}#top`],
    ["a trailing slash", `${URL_OK}/`],
    ["a short token", "https://www.doqtri.xyz/m/short"],
    ["another path", "https://www.doqtri.xyz/d/AbCdEfGhIjKlMnOpQrStUvWxYz012345"],
    ["empty", ""],
    ["a number", 42],
  ])("refuses %s", (_name, value) => {
    const error = refusal(() => validateHackathonSnapshot(snapshot({ mindmap_url: value as string })));
    expect(error.field).toBe("mindmap_url");
    expect(error.problem).toBe("invalid");
  });

  it("takes null as no link, as the contract does", () => {
    expect(() => validateHackathonSnapshot(snapshot({ mindmap_url: null }))).not.toThrow();
  });

  it("refuses the port and case forms qdit refuses byte for byte", () => {
    for (const value of [
      "https://www.doqtri.xyz:443/m/AbCdEfGhIjKlMnOpQrStUvWxYz012345",
      "https://WWW.DOQTRI.XYZ/m/AbCdEfGhIjKlMnOpQrStUvWxYz012345",
    ]) {
      expect(refusal(() => validateHackathonSnapshot(snapshot({ mindmap_url: value }))).field).toBe("mindmap_url");
    }
  });

  it("still refuses any other unknown top-level key", () => {
    const value = { ...snapshot(), mindmap: URL_OK } as unknown as HackathonSnapshot;
    expect(refusal(() => validateHackathonSnapshot(value))).toMatchObject({ field: "mindmap", problem: "unknown_field" });
  });

  it("withMindmapUrl adds it and serializes once more, leaving the input as it was", () => {
    const base = snapshot();
    const { snapshot: linked, body } = withMindmapUrl(base, URL_OK);
    expect(linked).toEqual({ ...base, mindmap_url: URL_OK });
    expect(body).toBe(JSON.stringify(linked));
    expect(JSON.parse(body).snapshot_id).toBe(base.snapshot_id);
    expect("mindmap_url" in base).toBe(false);
  });

  it("withMindmapUrl refuses a bad link", () => {
    expect(refusal(() => withMindmapUrl(snapshot(), "http://x.test/m/AbCdEfGhIjKlMnOpQrStUvWxYz012345")).field).toBe(
      "mindmap_url",
    );
  });
});

// ---------------------------------------------------------------------------
// buildHackathonSnapshot, against an in-memory Supabase
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** Just the query builder calls the builder makes, filtering in memory. */
function fakeSupabase(tables: Record<string, Row[]>, seen: string[] = []): SupabaseClient {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const query = {
        select(columns: string) {
          seen.push(`${table}: ${columns}`);
          return query;
        },
        eq(column: string, value: unknown) {
          rows = rows.filter((r) => r[column] === value);
          return query;
        },
        in(column: string, values: unknown[]) {
          rows = rows.filter((r) => values.includes(r[column]));
          return query;
        },
        order(column: string) {
          rows.sort((a, b) => String(a[column]).localeCompare(String(b[column])));
          return query;
        },
        limit(n: number) {
          rows = rows.slice(0, n);
          return query;
        },
        then(resolve: (value: { data: Row[]; error: null }) => unknown) {
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
}

const row = (id: string, title: string, extra: Row = {}): Row => ({
  id,
  workspace_id: WS,
  title,
  markdown: `# ${title}\n\n## Escrow\n`,
  mindmap: null,
  mindmap_hash: null,
  version: 4,
  created_at: "2026-11-20T09:00:00.123456+00:00",
  updated_at: "2026-11-20T10:00:00+00:00",
  source_template_id: null,
  ...extra,
});

describe("buildHackathonSnapshot", () => {
  const stored = map("Payroll", "Escrow");

  it("builds the contract's payload from the workspace's notes", async () => {
    const seen: string[] = [];
    const supabase = fakeSupabase(
      {
        documents: [
          row(A, "Payroll", { mindmap: stored }),
          row(B, "From market", { source_template_id: "tpl-1" }),
          row(C, "Imported", { mindmap: { version: 9 } }),
          row("d0000000-0000-4000-8000-000000000004", "Elsewhere", { workspace_id: "other" }),
        ],
        ingests: [{ document_id: C }, { document_id: null }],
      },
      seen,
    );
    const { snapshot: built, body, warnings } = await buildHackathonSnapshot({
      supabase,
      sourceClient: supabase,
      workspaceId: WS,
      hackathonSlug: "stellar-build-2026",
      now: () => new Date("2026-11-20T15:04:05.000Z"),
    });

    expect(Object.keys(built)).toEqual([
      "hackathon_slug",
      "snapshot_id",
      "workspace_id",
      "generated_at",
      "notes",
      "global_mindmap",
    ]);
    expect(built.snapshot_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(built.generated_at).toBe("2026-11-20T15:04:05.000Z");
    expect(built.workspace_id).toBe(WS);
    expect(body).toBe(JSON.stringify(built));
    expect(warnings).toEqual([]);
    expect(seen[0]).toContain("created_at");

    expect(built.notes.map((n) => [n.title, n.source])).toEqual([
      ["From market", "template"],
      ["Imported", "import"],
      ["Payroll", null],
    ]);
    const payroll = built.notes.find((n) => n.doc_id === A)!;
    expect(payroll).toEqual({
      doc_id: A,
      title: "Payroll",
      markdown: "# Payroll\n\n## Escrow\n",
      mindmap: stored,
      created_at: "2026-11-20T09:00:00.123Z",
      updated_at: "2026-11-20T10:00:00.000Z",
      version: null,
      source: null,
    });
    // A stored map doqtri cannot read is sent as null.
    expect(built.notes.find((n) => n.doc_id === C)!.mindmap).toBeNull();

    // Every note reaches the shared Escrow concept, so it is a hub of all three.
    const escrow = built.global_mindmap.nodes.find((n) => n.id === "concept:escrow")!;
    expect(escrow).toMatchObject({ kind: "hub", doc_ids: [A, B, C] });
  });

  it("leaves the sender's hidden nodes out of global_mindmap, and so out of the body (DOQ-54)", async () => {
    const supabase = fakeSupabase({ documents: [row(A, "Payroll", { mindmap: stored })], ingests: [] });
    const args = { supabase, sourceClient: supabase, workspaceId: WS, hackathonSlug: "h" };
    const shown = await buildHackathonSnapshot(args);
    expect(shown.snapshot.global_mindmap.nodes.map((n) => n.id)).toContain("concept:escrow");
    const hidden = await buildHackathonSnapshot({ ...args, hiddenNodeIds: new Set(["concept:escrow"]) });
    expect(hidden.snapshot.global_mindmap.nodes.map((n) => n.id)).not.toContain("concept:escrow");
    expect(hidden.snapshot.global_mindmap.links.some((l) => l.source === "concept:escrow" || l.target === "concept:escrow")).toBe(false);
    expect(hidden.body).toBe(JSON.stringify(hidden.snapshot));
    expect(hidden.body).not.toContain("concept:escrow");
    // The note itself is unchanged: hiding is a mindmap setting.
    expect(hidden.snapshot.notes).toEqual(shown.snapshot.notes);
  });

  it("makes a new snapshot_id each time", async () => {
    const supabase = fakeSupabase({ documents: [row(A, "Payroll")], ingests: [] });
    const args = { supabase, sourceClient: supabase, workspaceId: WS, hackathonSlug: "h" };
    const [one, two] = await Promise.all([buildHackathonSnapshot(args), buildHackathonSnapshot(args)]);
    expect(one.snapshot.snapshot_id).not.toBe(two.snapshot.snapshot_id);
  });

  it("refuses a bad slug before reading anything", async () => {
    const seen: string[] = [];
    await expect(
      buildHackathonSnapshot({
        supabase: fakeSupabase({}, seen),
        sourceClient: fakeSupabase({}, seen),
        workspaceId: WS,
        hackathonSlug: "Bad Slug",
      }),
    ).rejects.toMatchObject({ field: "hackathon_slug" });
    expect(seen).toEqual([]);
  });

  it("refuses more than 200 notes", async () => {
    const documents = Array.from({ length: 205 }, (_, i) =>
      row(`a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`, `Note ${String(i).padStart(3, "0")}`),
    );
    const supabase = fakeSupabase({ documents, ingests: [] });
    await expect(
      buildHackathonSnapshot({ supabase, sourceClient: supabase, workspaceId: WS, hackathonSlug: "h" }),
    ).rejects.toMatchObject({ field: "notes", problem: "too_many" });
  });

  it("sends an over-64 KiB stored map as null, with a warning, and still sends the note", async () => {
    const huge = map("Payroll", ...Array.from({ length: 900 }, (_, i) => `Concept number ${i} ${"x".repeat(60)}`));
    expect(JSON.stringify(huge).length).toBeGreaterThan(HACKATHON_LIMITS.mindmapBytes);
    const supabase = fakeSupabase({ documents: [row(A, "Payroll", { mindmap: huge }), row(B, "Small", { mindmap: map("Small", "Escrow") })], ingests: [] });
    const { snapshot: built, body, warnings } = await buildHackathonSnapshot({ supabase, sourceClient: supabase, workspaceId: WS, hackathonSlug: "h" });
    expect(built.notes.find((n) => n.doc_id === A)!.mindmap).toBeNull();
    expect(built.notes.find((n) => n.doc_id === B)!.mindmap).not.toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(A);
    expect(warnings[0]).toContain("Payroll");
    // The global mindmap still draws the big map's concepts.
    expect(built.global_mindmap.nodes.some((n) => n.label.startsWith("Concept number 899"))).toBe(true);
    expect(body).toBe(JSON.stringify(built));
  });

  it("reads imports through sourceClient, not the session client", async () => {
    // The session client sees no ingests (RLS shows only the caller's own).
    const supabase = fakeSupabase({ documents: [row(A, "Payroll")], ingests: [] });
    const sourceClient = fakeSupabase({ ingests: [{ document_id: A }] });
    const { snapshot: built } = await buildHackathonSnapshot({ supabase, sourceClient, workspaceId: WS, hackathonSlug: "h" });
    expect(built.notes[0].source).toBe("import");
  });
});
