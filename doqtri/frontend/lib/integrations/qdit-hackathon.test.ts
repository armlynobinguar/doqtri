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

  it("passes validation for the notes it was built from", () => {
    const global = serializeGlobalMindmap(docs);
    const notes = docs.map((d) => note(d.id, { title: d.title }));
    expect(() => validateHackathonSnapshot(snapshot({ notes, global_mindmap: global }))).not.toThrow();
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
    const { snapshot: built, body } = await buildHackathonSnapshot({
      supabase,
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

  it("makes a new snapshot_id each time", async () => {
    const supabase = fakeSupabase({ documents: [row(A, "Payroll")], ingests: [] });
    const args = { supabase, workspaceId: WS, hackathonSlug: "h" };
    const [one, two] = await Promise.all([buildHackathonSnapshot(args), buildHackathonSnapshot(args)]);
    expect(one.snapshot.snapshot_id).not.toBe(two.snapshot.snapshot_id);
  });

  it("refuses a bad slug before reading anything", async () => {
    const seen: string[] = [];
    await expect(
      buildHackathonSnapshot({ supabase: fakeSupabase({}, seen), workspaceId: WS, hackathonSlug: "Bad Slug" }),
    ).rejects.toMatchObject({ field: "hackathon_slug" });
    expect(seen).toEqual([]);
  });

  it("refuses more than 200 notes", async () => {
    const documents = Array.from({ length: 205 }, (_, i) =>
      row(`a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`, `Note ${String(i).padStart(3, "0")}`),
    );
    await expect(
      buildHackathonSnapshot({ supabase: fakeSupabase({ documents, ingests: [] }), workspaceId: WS, hackathonSlug: "h" }),
    ).rejects.toMatchObject({ field: "notes", problem: "too_many" });
  });

  it("reads imports through sourceClient when given", async () => {
    const supabase = fakeSupabase({ documents: [row(A, "Payroll")], ingests: [] });
    const sourceClient = fakeSupabase({ ingests: [{ document_id: A }] });
    const { snapshot: built } = await buildHackathonSnapshot({ supabase, sourceClient, workspaceId: WS, hackathonSlug: "h" });
    expect(built.notes[0].source).toBe("import");
  });
});
