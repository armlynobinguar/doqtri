import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildGlobalMindmapWithReach } from "@/lib/global-mindmap";
import { docFromRow, VAULT_DOC_COLUMNS, type VaultDocRow } from "@/lib/load-docs";
import { isMindmapShareUrl } from "@/lib/mindmap-share";
import type { Doc } from "@/lib/types";

/**
 * The hackathon snapshot doqtri sends to qdit (WP-4.7, D-117, D-118;
 * server-only: hashing uses `node:crypto`).
 *
 * docs/integration/CONTRACT.md section 8, `POST /projects/{id}/hackathon-snapshots`,
 * is the reference for every field and limit here. The body is built from
 * doqtri's own database, never from what a browser sent, and checked against
 * every limit before anything is sent: qdit answers any violation with 400,
 * and a body it never receives cannot half-land.
 *
 * Replays. qdit keys a snapshot on `snapshot_id` plus the SHA-256 of the raw
 * body bytes, so a retry must send the same bytes. buildHackathonSnapshot()
 * serializes once and returns that string as `body`; send `body`, and resend
 * the same `body` on a retry. A new press of Send builds a new snapshot (and
 * so a new snapshot_id).
 *
 * Who may send is the caller's to check: doqtri sends only for a workspace
 * admin (D-10), and qdit only for a project admin.
 */

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/**
 * How a note started in doqtri. Mapping, from what the database records:
 *
 *   template  `documents.source_template_id` is set: the note was copied from
 *             a community (market) template by /api/market/claim. The id is
 *             set null if the template row is deleted, and then the note
 *             falls through to the rules below.
 *   import    an `ingests` row points at the note (`document_id`): the
 *             upload pipeline (lib/ingest/pipeline.ts) turned a PDF, DOCX,
 *             PPTX or text file into it. An import whose ingest row could not
 *             be written leaves no trace and falls through.
 *   null      anything else. Notes from /api/notes, blank or from a built-in
 *             gallery template (lib/templates.ts), are stored identically:
 *             the route records no marker, so a note typed from scratch
 *             cannot be told from one started from a built-in template.
 *             `editor` is therefore never claimed today; it is in the type
 *             for when /api/notes records how a note started.
 */
export type HackathonNoteSource = "editor" | "template" | "import" | null;

export type HackathonNote = {
  doc_id: string;
  title: string;
  markdown: string;
  /** The stored per-note concept map, or null when none is stored (or it does not parse). */
  mindmap: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  /**
   * DoqtriRegistry `Document.version` when anchored. doqtri does not store
   * it (it reads it from the chain when it needs it, qdit-linking.ts), so
   * this is null; documents.version is the save counter, not this.
   */
  version: number | null;
  source: HackathonNoteSource;
};

export type HackathonMindmapNode = {
  id: string;
  label: string;
  kind: string;
  depth: number;
  doc_ids: string[];
};

export type HackathonMindmapLink = { source: string; target: string };

export type HackathonGlobalMindmap = {
  nodes: HackathonMindmapNode[];
  links: HackathonMindmapLink[];
};

export type HackathonSnapshot = {
  hackathon_slug: string;
  snapshot_id: string;
  workspace_id: string;
  generated_at: string;
  notes: HackathonNote[];
  global_mindmap: HackathonGlobalMindmap;
  /**
   * Optional (contract v1.4.0, QDIT-66): the public read-only copy of
   * `global_mindmap` at doqtri's `/m/<token>` (WP-4.7, DOQ-53,
   * lib/mindmap-share.ts). doqtri leaves it out when no link was made for
   * this send; qdit reads null the same way.
   */
  mindmap_url?: string | null;
};

// ---------------------------------------------------------------------------
// Limits (CONTRACT.md section 4 and section 8)
// ---------------------------------------------------------------------------

export const HACKATHON_LIMITS = {
  notes: 200,
  titleChars: 300,
  markdownBytes: 100 * 1024,
  mindmapBytes: 64 * 1024,
  nodes: 5_000,
  links: 20_000,
  nodeIdChars: 128,
  labelChars: 300,
  kindChars: 32,
  bodyBytes: 2 * 1024 * 1024,
} as const;

export const HACKATHON_SLUG = /^[a-z0-9-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SOURCES: ReadonlySet<unknown> = new Set(["editor", "template", "import", null]);

export type HackathonSnapshotProblem =
  | "invalid"
  | "too_many"
  | "too_long"
  | "duplicate"
  | "unknown_reference"
  | "unknown_field";

/**
 * A snapshot that breaks a contract rule. `field` is the path qdit would name
 * in `details.fields` (`notes[3].markdown`, `global_mindmap.links[12].target`,
 * `body` for the whole JSON).
 */
export class HackathonSnapshotError extends Error {
  readonly field: string;
  readonly problem: HackathonSnapshotProblem;
  readonly limit: number | null;
  readonly actual: number | null;

  constructor(
    field: string,
    problem: HackathonSnapshotProblem,
    message: string,
    extra: { limit?: number; actual?: number } = {},
  ) {
    super(`${field}: ${message}`);
    this.name = "HackathonSnapshotError";
    this.field = field;
    this.problem = problem;
    this.limit = extra.limit ?? null;
    this.actual = extra.actual ?? null;
  }
}

const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");
/** Lengths are Unicode code points, as the contract counts characters. */
const codePoints = (value: string) => [...value].length;

/**
 * A global mindmap label qdit accepts: one over 300 code points keeps its
 * first 299 and gains "…". Labels come from headings and concept names,
 * which have no length limit of their own, and one long heading should not
 * stop the whole snapshot.
 */
function wireLabel(label: string): string {
  const chars = [...label];
  return chars.length <= HACKATHON_LIMITS.labelChars ? label : `${chars.slice(0, HACKATHON_LIMITS.labelChars - 1).join("")}…`;
}

// ---------------------------------------------------------------------------
// The global mindmap
// ---------------------------------------------------------------------------

/**
 * A node id qdit accepts: ids over 128 characters (a concept id is
 * `concept:<normalized label>`, and labels run to 300) become `c:` plus the
 * first 16 hex digits of the SHA-256 of the original id. Stable across
 * snapshots, and no original id starts with `c:`.
 */
export function wireNodeId(id: string): string {
  if (codePoints(id) <= HACKATHON_LIMITS.nodeIdChars) return id;
  return `c:${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 16)}`;
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The workspace's global mindmap as the contract shape, from the same
 * buildGlobalMindmap() the vault's global mindmap page draws.
 *
 * Stable: the same notes give the same output whatever order they come in.
 * Notes are built in id order, nodes are sorted by id, links by source then
 * target, and each node's `doc_ids` (the notes that reach it: a document
 * node's own note and the notes pointing at it, a concept's notes that name
 * it) are sorted. Only the contract's fields are sent: `href` and `summary`
 * stay behind. Ids over 128 code points are shortened (wireNodeId) and labels
 * over 300 cut (wireLabel), so the result always passes those two checks.
 *
 * `hidden` (WP-4.7, DOQ-54): the ids, as the global mindmap names them
 * (before wireNodeId), of nodes the sender hid in their `global` studio
 * style (hiddenNodeIds in lib/mindmap-style.ts). Each is left out, with every
 * link that touches it, before anything else, so the snapshot qdit gets (its
 * label list, counts and AI grader), the stored share and the shared page all
 * lack it. A hidden node's neighbours stay, as on the canvas. `doc_ids` and
 * `notes` are unchanged: hiding is a mindmap setting, not a note's.
 */
export function serializeGlobalMindmap(docs: Doc[], hidden: ReadonlySet<string> = new Set()): HackathonGlobalMindmap {
  const ordered = [...docs].sort((a, b) => byString(a.id, b.id));
  const { graph, reachedBy } = buildGlobalMindmapWithReach(ordered);

  const nodes: HackathonMindmapNode[] = graph.nodes
    .filter((node) => !hidden.has(node.id))
    .map((node) => ({
      id: wireNodeId(node.id),
      label: wireLabel(node.label),
      kind: node.kind,
      depth: node.depth,
      doc_ids: [...(reachedBy.get(node.id) ?? [])].sort(byString),
    }))
    .sort((a, b) => byString(a.id, b.id));

  const links: HackathonMindmapLink[] = graph.links
    .filter((link) => !hidden.has(link.source) && !hidden.has(link.target))
    .map((link) => ({ source: wireNodeId(link.source), target: wireNodeId(link.target) }))
    .sort((a, b) => byString(a.source, b.source) || byString(a.target, b.target));

  return { nodes, links };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function exactKeys(
  value: unknown,
  keys: readonly string[],
  field: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HackathonSnapshotError(field, "invalid", "must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key) && !optional.includes(key)) {
      throw new HackathonSnapshotError(field ? `${field}.${key}` : key, "unknown_field", "is not a contract field");
    }
  }
  for (const key of keys) {
    if (!(key in record)) {
      throw new HackathonSnapshotError(field ? `${field}.${key}` : key, "invalid", "is missing");
    }
  }
  return record;
}

function maxChars(value: unknown, limit: number, field: string, min = 0): string {
  if (typeof value !== "string") throw new HackathonSnapshotError(field, "invalid", "must be a string");
  const length = codePoints(value);
  if (length < min) throw new HackathonSnapshotError(field, "invalid", `must be at least ${min} character(s)`);
  if (length > limit) {
    throw new HackathonSnapshotError(field, "too_long", `is ${length} characters, at most ${limit}`, {
      limit,
      actual: length,
    });
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new HackathonSnapshotError(field, "invalid", "must be a lowercase UUID");
  }
  return value;
}

function timestamp(value: unknown, field: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new HackathonSnapshotError(field, "invalid", "must be an ISO 8601 timestamp");
  }
}

function count(list: unknown, limit: number, field: string): unknown[] {
  if (!Array.isArray(list)) throw new HackathonSnapshotError(field, "invalid", "must be an array");
  if (list.length > limit) {
    throw new HackathonSnapshotError(field, "too_many", `has ${list.length} entries, at most ${limit}`, {
      limit,
      actual: list.length,
    });
  }
  return list;
}

const NOTE_KEYS = ["doc_id", "title", "markdown", "mindmap", "created_at", "updated_at", "version", "source"] as const;
const NODE_KEYS = ["id", "label", "kind", "depth", "doc_ids"] as const;

/**
 * Checks `snapshot` against every rule of the contract and returns it
 * serialized: the exact bytes to send. Throws HackathonSnapshotError naming
 * the first field that breaks a rule.
 *
 * Pure: no database, no clock, no network.
 */
export function validateHackathonSnapshot(snapshot: HackathonSnapshot): string {
  const top = exactKeys(
    snapshot,
    ["hackathon_slug", "snapshot_id", "workspace_id", "generated_at", "notes", "global_mindmap"],
    "",
    ["mindmap_url"],
  );

  if (typeof top.hackathon_slug !== "string" || !HACKATHON_SLUG.test(top.hackathon_slug)) {
    throw new HackathonSnapshotError("hackathon_slug", "invalid", "must match ^[a-z0-9-]{1,64}$");
  }
  uuid(top.snapshot_id, "snapshot_id");
  uuid(top.workspace_id, "workspace_id");
  timestamp(top.generated_at, "generated_at");
  // qdit also checks the host against its DOQTRI_ORIGIN, which doqtri cannot
  // know; everything else about the link is checked here.
  // null and left out both mean no link (contract v1.4.0); doqtri leaves it
  // out, which a qdit before v1.4.0 also takes.
  if ("mindmap_url" in top && top.mindmap_url !== null && !isMindmapShareUrl(top.mindmap_url)) {
    throw new HackathonSnapshotError("mindmap_url", "invalid", "must be https://<doqtri origin>/m/<token>");
  }

  const notes = count(top.notes, HACKATHON_LIMITS.notes, "notes");
  const docIds = new Set<string>();
  notes.forEach((value, i) => {
    const field = `notes[${i}]`;
    const note = exactKeys(value, NOTE_KEYS, field);
    const docId = uuid(note.doc_id, `${field}.doc_id`);
    if (docIds.has(docId)) throw new HackathonSnapshotError(`${field}.doc_id`, "duplicate", "appears twice in notes");
    docIds.add(docId);

    maxChars(note.title, HACKATHON_LIMITS.titleChars, `${field}.title`);

    if (typeof note.markdown !== "string") {
      throw new HackathonSnapshotError(`${field}.markdown`, "invalid", "must be a string");
    }
    const markdownBytes = utf8Bytes(note.markdown);
    if (markdownBytes > HACKATHON_LIMITS.markdownBytes) {
      throw new HackathonSnapshotError(
        `${field}.markdown`,
        "too_long",
        `is ${markdownBytes} bytes, at most ${HACKATHON_LIMITS.markdownBytes}`,
        { limit: HACKATHON_LIMITS.markdownBytes, actual: markdownBytes },
      );
    }

    if (note.mindmap !== null) {
      if (typeof note.mindmap !== "object" || Array.isArray(note.mindmap)) {
        throw new HackathonSnapshotError(`${field}.mindmap`, "invalid", "must be an object or null");
      }
      const mindmapBytes = utf8Bytes(JSON.stringify(note.mindmap));
      if (mindmapBytes > HACKATHON_LIMITS.mindmapBytes) {
        throw new HackathonSnapshotError(
          `${field}.mindmap`,
          "too_long",
          `is ${mindmapBytes} bytes, at most ${HACKATHON_LIMITS.mindmapBytes}`,
          { limit: HACKATHON_LIMITS.mindmapBytes, actual: mindmapBytes },
        );
      }
    }

    timestamp(note.created_at, `${field}.created_at`);
    timestamp(note.updated_at, `${field}.updated_at`);
    if (note.version !== null && !(Number.isInteger(note.version) && (note.version as number) >= 1)) {
      throw new HackathonSnapshotError(`${field}.version`, "invalid", "must be an integer >= 1, or null");
    }
    if (!SOURCES.has(note.source)) {
      throw new HackathonSnapshotError(`${field}.source`, "invalid", "must be editor, template, import or null");
    }
  });

  const global = exactKeys(top.global_mindmap, ["nodes", "links"], "global_mindmap");
  const nodes = count(global.nodes, HACKATHON_LIMITS.nodes, "global_mindmap.nodes");
  const nodeIds = new Set<string>();
  nodes.forEach((value, i) => {
    const field = `global_mindmap.nodes[${i}]`;
    const node = exactKeys(value, NODE_KEYS, field);
    const id = maxChars(node.id, HACKATHON_LIMITS.nodeIdChars, `${field}.id`, 1);
    if (nodeIds.has(id)) throw new HackathonSnapshotError(`${field}.id`, "duplicate", "appears twice in nodes");
    nodeIds.add(id);
    maxChars(node.label, HACKATHON_LIMITS.labelChars, `${field}.label`);
    maxChars(node.kind, HACKATHON_LIMITS.kindChars, `${field}.kind`, 1);
    if (!Number.isInteger(node.depth) || (node.depth as number) < 0) {
      throw new HackathonSnapshotError(`${field}.depth`, "invalid", "must be an integer >= 0");
    }
    if (!Array.isArray(node.doc_ids)) {
      throw new HackathonSnapshotError(`${field}.doc_ids`, "invalid", "must be an array");
    }
    node.doc_ids.forEach((docId, j) => {
      if (typeof docId !== "string" || !docIds.has(docId)) {
        throw new HackathonSnapshotError(`${field}.doc_ids[${j}]`, "unknown_reference", "is not a doc_id in notes");
      }
    });
  });

  const links = count(global.links, HACKATHON_LIMITS.links, "global_mindmap.links");
  links.forEach((value, i) => {
    const field = `global_mindmap.links[${i}]`;
    const link = exactKeys(value, ["source", "target"], field);
    for (const end of ["source", "target"] as const) {
      if (typeof link[end] !== "string" || !nodeIds.has(link[end] as string)) {
        throw new HackathonSnapshotError(`${field}.${end}`, "unknown_reference", "is not a node id");
      }
    }
  });

  const body = JSON.stringify(snapshot);
  const bodyBytes = utf8Bytes(body);
  if (bodyBytes > HACKATHON_LIMITS.bodyBytes) {
    throw new HackathonSnapshotError("body", "too_long", `is ${bodyBytes} bytes, at most ${HACKATHON_LIMITS.bodyBytes}`, {
      limit: HACKATHON_LIMITS.bodyBytes,
      actual: bodyBytes,
    });
  }
  return body;
}

/**
 * `snapshot` with `mindmap_url` added, checked and serialized again: the
 * bytes to send once the send route has stored the link (WP-4.7, DOQ-53).
 * The link goes in before the body is hashed and sent, so a retry of these
 * bytes carries the same link. Throws HackathonSnapshotError like
 * validateHackathonSnapshot(), e.g. when the link makes the body too large.
 */
export function withMindmapUrl(
  snapshot: HackathonSnapshot,
  mindmapUrl: string,
): { snapshot: HackathonSnapshot; body: string } {
  const next: HackathonSnapshot = { ...snapshot, mindmap_url: mindmapUrl };
  return { snapshot: next, body: validateHackathonSnapshot(next) };
}

// ---------------------------------------------------------------------------
// Building it from the database
// ---------------------------------------------------------------------------

type SnapshotRow = VaultDocRow & { updated_at: string; source_template_id: string | null };

/** The stored map, sent as stored, when it is one doqtri can read; else null. */
function storedMindmap(doc: Doc, raw: unknown): Record<string, unknown> | null {
  return doc.mindmap && raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

const mindmapTooLarge = (mindmap: Record<string, unknown>) =>
  utf8Bytes(JSON.stringify(mindmap)) > HACKATHON_LIMITS.mindmapBytes;

const iso = (value: string) => new Date(value).toISOString();

/**
 * Builds and checks the snapshot of `workspaceId`'s notes for `hackathonSlug`.
 *
 * @param params.supabase MUST be the caller's session client
 *   (createSupabaseServerClient()): RLS is what limits the notes to the ones
 *   the caller may read, exactly as loadVaultDocs() does for the vault pages.
 *   Never pass the service role here: it would send notes the caller cannot
 *   read.
 * @param params.sourceClient the service-role client, used only to read the
 *   `ingests` rows of the notes already loaded through `supabase`. `ingests`
 *   RLS shows a user only their own imports, so through the session client a
 *   teammate's imported note would read as `source: null`.
 *
 * The caller must already have checked that the user is an admin of
 * `workspaceId` (D-10); this function does not.
 *
 * Returns the snapshot, `body` (its serialized form: send `body`, and resend
 * that same string on a retry, see the top of this file) and `warnings`: one
 * line per note whose stored mindmap was over 64 KiB and was sent as null
 * instead of failing the snapshot.
 */
export async function buildHackathonSnapshot(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  hackathonSlug: string;
  sourceClient: SupabaseClient;
  /**
   * Global mindmap node ids the sender hid in their `global` style
   * (hiddenNodeIds()): left out of `global_mindmap` with their links (DOQ-54).
   */
  hiddenNodeIds?: ReadonlySet<string>;
  now?: () => Date;
}): Promise<{ snapshot: HackathonSnapshot; body: string; warnings: string[] }> {
  const { supabase, workspaceId, hackathonSlug } = params;
  if (!HACKATHON_SLUG.test(hackathonSlug)) {
    throw new HackathonSnapshotError("hackathon_slug", "invalid", "must match ^[a-z0-9-]{1,64}$");
  }

  // One more than the limit, so too many notes is caught without loading
  // every one of them.
  const { data, error } = await supabase
    .from("documents")
    .select(`${VAULT_DOC_COLUMNS}, updated_at, source_template_id`)
    .eq("workspace_id", workspaceId)
    .order("title", { ascending: true })
    .limit(HACKATHON_LIMITS.notes + 1);
  if (error) throw new Error(`Failed to load the workspace's notes: ${error.message}`);
  const rows = (data ?? []) as unknown as SnapshotRow[];
  if (rows.length > HACKATHON_LIMITS.notes) {
    throw new HackathonSnapshotError("notes", "too_many", `the workspace has more than ${HACKATHON_LIMITS.notes} notes`, {
      limit: HACKATHON_LIMITS.notes,
      actual: rows.length,
    });
  }

  const imported = new Set<string>();
  if (rows.length > 0) {
    const { data: ingests, error: ingestError } = await params.sourceClient
      .from("ingests")
      .select("document_id")
      .in(
        "document_id",
        rows.map((row) => row.id),
      );
    if (ingestError) throw new Error(`Failed to load the notes' imports: ${ingestError.message}`);
    for (const row of (ingests ?? []) as { document_id: string | null }[]) {
      if (row.document_id) imported.add(row.document_id);
    }
  }

  const docs = rows.map(docFromRow);
  const warnings: string[] = [];
  const notes: HackathonNote[] = rows.map((row, i) => {
    let mindmap = storedMindmap(docs[i], row.mindmap);
    if (mindmap && mindmapTooLarge(mindmap)) {
      // qdit takes at most 64 KiB per map. The global mindmap below still
      // uses it; only this note's own copy is left out.
      warnings.push(`"${row.title}" (${row.id}): its mindmap is over 64 KiB and was not sent.`);
      mindmap = null;
    }
    return {
      doc_id: row.id,
      title: row.title,
      markdown: row.markdown,
      mindmap,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      version: null,
      source: row.source_template_id ? "template" : imported.has(row.id) ? "import" : null,
    };
  });

  const snapshot: HackathonSnapshot = {
    hackathon_slug: hackathonSlug,
    snapshot_id: randomUUID(),
    workspace_id: workspaceId,
    generated_at: (params.now?.() ?? new Date()).toISOString(),
    notes,
    global_mindmap: serializeGlobalMindmap(docs, params.hiddenNodeIds),
  };
  return { snapshot, body: validateHackathonSnapshot(snapshot), warnings };
}
