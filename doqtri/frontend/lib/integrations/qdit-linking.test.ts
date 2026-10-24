import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  QditError,
  type QditClient,
  type QditMilestone,
  type QditProject,
} from "@/lib/integrations/qdit-client";
import {
  adoptMilestoneLink,
  createMilestoneLink,
  docUrl,
  LinkingError,
  linkProject,
  relinkMilestone,
  remapAfterSave,
  syncQditLinks,
  unlinkMilestone,
  unlinkProject,
} from "@/lib/integrations/qdit-linking";
import type { QditLinkRow } from "@/lib/node-links";

/*
 * Two in-memory stand-ins: a service-role Supabase client over the tables
 * this file touches (with the unique checks and RPCs of
 * 20261025110000_qdit_linking.sql), and qdit itself as section 8 of the
 * contract describes it (one milestone per (doc_id, node_id), 409 reasons,
 * 404 for what the user cannot see). Every qdit call is recorded.
 */

type Row = Record<string, unknown>;
type Db = { documents: Row[]; doc_project_links: Row[]; node_links: Row[] };

const DOC = "c2d1e0f9-8a7b-4c6d-9e5f-4a3b2c1d0e9f";
const PROJECT = "3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34";
const OTHER_PROJECT = "4f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34";
const USER = "11111111-1111-4111-8111-111111111111";

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function fakeDb(db: Db) {
  const uniqueClash = (table: keyof Db, rows: Row[]) => {
    if (table === "node_links") {
      const keys = rows.map((r) => `${r.document_id}|${r.node_id}`);
      if (new Set(keys).size !== keys.length) return true;
      const ms = rows.filter((r) => r.provider === "qdit").map((r) => r.qdit_milestone_id);
      if (new Set(ms).size !== ms.length) return true;
    }
    if (table === "doc_project_links") {
      const keys = rows.map((r) => r.document_id);
      if (new Set(keys).size !== keys.length) return true;
    }
    return false;
  };

  const client = {
    from(table: keyof Db) {
      const filters: ((r: Row) => boolean)[] = [];
      let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
      let payload: Row | null = null;
      let limit = Infinity;
      let orderBy: string | null = null;
      const run = (): { data: unknown; error: { message: string; code?: string } | null } => {
        const match = (r: Row) => filters.every((f) => f(r));
        if (op === "select") {
          let rows = db[table].filter(match);
          if (orderBy) rows = [...rows].sort((a, b) => String(a[orderBy!]).localeCompare(String(b[orderBy!])));
          return { data: rows.slice(0, limit).map((r) => ({ ...r })), error: null };
        }
        if (op === "insert" || op === "upsert") {
          const row: Row = { id: uuid(), created_at: new Date(seq).toISOString(), provider: "github", ...payload };
          let next = [...db[table], row];
          if (op === "upsert") {
            next = [...db[table].filter((r) => r.document_id !== row.document_id), row];
          }
          if (uniqueClash(table, next)) return { data: null, error: { message: "duplicate", code: "23505" } };
          db[table] = next;
          return { data: [{ ...row }], error: null };
        }
        if (op === "update") {
          const next = db[table].map((r) => (match(r) ? { ...r, ...payload } : r));
          if (uniqueClash(table, next)) return { data: null, error: { message: "duplicate", code: "23505" } };
          const changed = next.filter((r, i) => r !== db[table][i]);
          db[table] = next;
          return { data: changed.map((r) => ({ ...r })), error: null };
        }
        const removed = db[table].filter(match);
        db[table] = db[table].filter((r) => !match(r));
        if (table === "doc_project_links") {
          // on delete cascade from node_links' project reference
          db.node_links = db.node_links.filter(
            (n) => !(n.provider === "qdit" && removed.some((d) => d.document_id === n.document_id)),
          );
        }
        return { data: removed, error: null };
      };
      const chain = {
        select: () => chain,
        insert: (row: Row) => ((op = "insert"), (payload = row), chain),
        upsert: (row: Row) => ((op = "upsert"), (payload = row), chain),
        update: (row: Row) => ((op = "update"), (payload = row), chain),
        delete: () => ((op = "delete"), chain),
        eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), chain),
        neq: (col: string, val: unknown) => (filters.push((r) => r[col] !== val), chain),
        order: (col: string) => ((orderBy = col), chain),
        limit: (n: number) => ((limit = n), chain),
        maybeSingle: async () => {
          const r = run();
          const rows = r.data as Row[] | null;
          return { data: rows?.[0] ?? null, error: r.error };
        },
        single: async () => {
          const r = run();
          const rows = r.data as Row[] | null;
          return rows?.length === 1 ? { data: rows[0], error: r.error } : { data: null, error: r.error ?? { message: "not one row" } };
        },
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve, reject),
      };
      return chain;
    },
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn === "apply_node_link_remap") {
        const doc = db.documents.find((d) => d.id === args.p_document_id);
        if (!doc || doc.version !== args.p_version) return { data: null, error: null };
        const changes = args.p_changes as { id: string; node_id: string; node_label?: string; qdit_state?: string }[];
        let count = 0;
        const next = db.node_links.map((r) => {
          const c = changes.find((x) => x.id === r.id && r.document_id === args.p_document_id);
          if (!c) return r;
          count++;
          return {
            ...r,
            node_id: c.node_id,
            node_label: c.node_label ?? r.node_label,
            qdit_state: r.provider === "qdit" ? (c.qdit_state ?? r.qdit_state) : null,
          };
        });
        if (uniqueClash("node_links", next)) return { data: null, error: { message: "duplicate", code: "23505" } };
        db.node_links = next;
        return { data: count, error: null };
      }
      if (fn === "claim_qdit_link_sync") {
        const link = db.doc_project_links.find((l) => l.document_id === args.p_document_id);
        if (!link) return { data: false, error: null };
        if (link.sync_lease && link.sync_lease !== args.p_lease) return { data: false, error: null };
        link.sync_lease = args.p_lease;
        return { data: true, error: null };
      }
      if (fn === "release_qdit_link_sync") {
        const link = db.doc_project_links.find((l) => l.document_id === args.p_document_id);
        if (link && link.sync_lease === args.p_lease) link.sync_lease = null;
        return { data: null, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    }),
  };
  return client as unknown as SupabaseClient & { rpc: ReturnType<typeof vi.fn> };
}

type QMilestone = { id: string; project: string; title: string; link: { id: string; doc_id: string; node_id: string; node_label: string; doc_version: number | null } | null };

function fakeQdit(state: {
  projects: QditProject[];
  docLinks: { project_id: string; doc_id: string; id: string }[];
  milestones: QMilestone[];
  /** Milestone ids this user can no longer see. */
  hidden?: Set<string>;
}) {
  const calls: string[] = [];
  const view = (m: QMilestone): QditMilestone => ({
    id: m.id,
    project: { id: m.project, name: "Soroban payroll", slug: "soroban-payroll" },
    title: m.title,
    description: null,
    status: "proposed",
    due_date: null,
    order_index: 0,
    url: "https://qdit.test/projects/soroban-payroll/milestones",
    link: m.link ? { ...m.link, created_at: "", updated_at: "" } : null,
    anchor: null,
    created_at: "",
    updated_at: "",
  });
  const notFound = () => new QditError("not_found", "Not found", { status: 404, code: "not_found" });
  const conflict = (reason: string, details: Record<string, unknown> = {}) =>
    new QditError("conflict", `Conflict: ${reason}`, { status: 409, code: "conflict", reason, details: { reason, ...details } });
  const visible = (id: string) => {
    const m = state.milestones.find((x) => x.id === id);
    if (!m || state.hidden?.has(id)) throw notFound();
    return m;
  };
  const byLink = (linkId: string) => {
    const m = state.milestones.find((x) => x.link?.id === linkId);
    if (!m || state.hidden?.has(m.id)) throw notFound();
    return m;
  };
  const holder = (docId: string, nodeId: string, except: string) =>
    state.milestones.find((x) => x.id !== except && x.link?.doc_id === docId && x.link.node_id === nodeId);

  const client: QditClient = {
    me: async () => ({ user: { id: "q", username: "ana", display_name: null, avatar_url: null, wallet_address: null }, client_id: "c" }),
    listProjects: async () => ({ data: state.projects, nextCursor: null }),
    listAllProjects: async () => (calls.push("GET /projects"), state.projects),
    async linkDoc(projectId, doc) {
      calls.push(`POST /projects/${projectId}/docs`);
      const other = state.docLinks.find((l) => l.doc_id === doc.doc_id && l.project_id !== projectId);
      if (other) throw conflict("doc_linked_elsewhere");
      let link = state.docLinks.find((l) => l.doc_id === doc.doc_id);
      if (!link) state.docLinks.push((link = { project_id: projectId, doc_id: doc.doc_id, id: uuid() }));
      return { id: link.id, project_id: projectId, doc_id: doc.doc_id, doc_title: doc.doc_title, doc_url: doc.doc_url, created_at: "", updated_at: "" };
    },
    async unlinkDoc(projectId, docId) {
      calls.push(`DELETE /projects/${projectId}/docs/${docId}`);
      const link = state.docLinks.find((l) => l.doc_id === docId && l.project_id === projectId);
      if (!link) throw notFound();
      state.docLinks = state.docLinks.filter((l) => l !== link);
      const removed = state.milestones.filter((m) => m.link?.doc_id === docId).map((m) => m.link!.id);
      for (const m of state.milestones) if (m.link?.doc_id === docId) m.link = null;
      return { removed_link_ids: removed };
    },
    async createMilestone(input) {
      calls.push("POST /milestones");
      if (!state.docLinks.some((l) => l.doc_id === input.link.doc_id && l.project_id === input.project_id)) {
        throw conflict("doc_not_linked");
      }
      const taken = holder(input.link.doc_id, input.link.node_id, "");
      if (taken) throw conflict("node_already_linked", { milestone_id: taken.id });
      const m: QMilestone = {
        id: uuid(),
        project: input.project_id,
        title: input.title,
        link: { id: uuid(), doc_id: input.link.doc_id, node_id: input.link.node_id, node_label: input.title, doc_version: input.link.doc_version },
      };
      state.milestones.push(m);
      return view(m);
    },
    getMilestone: async (id) => (calls.push(`GET /milestones/${id}`), view(visible(id))),
    async renameMilestone(id, title) {
      calls.push(`PATCH /milestones/${id} ${title}`);
      const m = visible(id);
      if (!m.link) throw conflict("milestone_not_linked");
      m.title = title;
      m.link.node_label = title;
      return view(m);
    },
    async updateLink(linkId, input) {
      calls.push(`PATCH /links/${linkId} ${JSON.stringify(input)}`);
      const m = byLink(linkId);
      if (input.node_id !== undefined) {
        const taken = holder(m.link!.doc_id, input.node_id, m.id);
        if (taken) throw conflict("node_already_linked", { milestone_id: taken.id });
        m.link!.node_id = input.node_id;
      }
      if (input.doc_version !== undefined) m.link!.doc_version = input.doc_version;
      return view(m);
    },
    async deleteLink(linkId) {
      calls.push(`DELETE /links/${linkId}`);
      const m = byLink(linkId);
      m.link = null;
    },
  };
  return { client, calls, state };
}

const project = (id: string, role: QditProject["role"]): QditProject => ({
  id,
  name: "Soroban payroll",
  slug: "soroban-payroll",
  description: null,
  status: "active",
  role,
  chain: null,
  url: "https://qdit.test/projects/soroban-payroll",
  created_at: "",
  updated_at: "",
});

let db: Db;
let admin: ReturnType<typeof fakeDb>;
let qdit: ReturnType<typeof fakeQdit>;
const chainVersion = vi.fn(async () => 3 as number | null);

const doc = (markdown: string) => ({ id: DOC, title: "Plan", markdown });

beforeEach(() => {
  seq = 100;
  db = { documents: [{ id: DOC, version: 5 }], doc_project_links: [], node_links: [] };
  admin = fakeDb(db);
  qdit = fakeQdit({ projects: [project(PROJECT, "admin"), project(OTHER_PROJECT, "member")], docLinks: [], milestones: [] });
  chainVersion.mockClear();
});

async function linked() {
  await linkProject({ admin, client: qdit.client, userId: USER, doc: { id: DOC, title: "Plan" }, projectId: PROJECT, siteUrl: "https://doqtri.test" });
}

async function milestoneOn(markdown: string, nodeId: string) {
  return createMilestoneLink({ admin, client: qdit.client, userId: USER, doc: doc(markdown), nodeId, chainVersion });
}

const qditRow = (id: string) => db.node_links.find((r) => r.id === id) as unknown as QditLinkRow;

describe("linkProject (D-09, D-10, D-45)", () => {
  it("links the note in qdit with doqtri's own URL, then records qdit's answer", async () => {
    await linked();
    expect(qdit.calls).toContain(`POST /projects/${PROJECT}/docs`);
    expect(db.doc_project_links).toEqual([
      expect.objectContaining({
        document_id: DOC,
        project_id: PROJECT,
        project_name: "Soroban payroll",
        project_slug: "soroban-payroll",
        doc_url: `https://doqtri.test/d/${DOC}`,
        linked_by: USER,
      }),
    ]);
  });

  it("builds the doc URL on the configured origin, whatever trailing slash", () => {
    expect(docUrl("https://www.doqtri.xyz/", DOC)).toBe(`https://www.doqtri.xyz/d/${DOC}`);
  });

  it("refuses a second project for the same note", async () => {
    await linked();
    await expect(
      linkProject({ admin, client: qdit.client, userId: USER, doc: { id: DOC, title: "Plan" }, projectId: OTHER_PROJECT, siteUrl: "https://doqtri.test" }),
    ).rejects.toMatchObject({ status: 409, code: "ALREADY_LINKED" });
  });

  it("refuses a project where the user is below admin in qdit, before asking qdit", async () => {
    await expect(
      linkProject({ admin, client: qdit.client, userId: USER, doc: { id: DOC, title: "Plan" }, projectId: OTHER_PROJECT, siteUrl: "https://doqtri.test" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(qdit.calls.some((c) => c.startsWith("POST"))).toBe(false);
    expect(db.doc_project_links).toEqual([]);
  });

  it("reports a note qdit links elsewhere and records nothing", async () => {
    qdit.state.docLinks.push({ project_id: OTHER_PROJECT, doc_id: DOC, id: uuid() });
    await expect(linked()).rejects.toMatchObject({ status: 409, code: "QDIT_LINKED_ELSEWHERE" });
    expect(db.doc_project_links).toEqual([]);
  });
});

describe("unlinkProject (D-22)", () => {
  it("unlinks in qdit and drops the project row and every qdit link, keeping GitHub ones", async () => {
    await linked();
    await milestoneOn("# A\n# B", "h1");
    db.node_links.push({ id: "gh", document_id: DOC, node_id: "h0", node_label: "A", provider: "github", repo: "a/b", number: 1 });
    const { removedLinkIds } = await unlinkProject({ admin, client: qdit.client, docId: DOC });
    expect(removedLinkIds).toHaveLength(1);
    expect(db.doc_project_links).toEqual([]);
    expect(db.node_links.map((r) => r.id)).toEqual(["gh"]);
  });

  it("takes a 404 as done while the project is still visible", async () => {
    await linked();
    qdit.state.docLinks = [];
    await unlinkProject({ admin, client: qdit.client, docId: DOC });
    expect(db.doc_project_links).toEqual([]);
  });

  it("keeps everything when the project is out of sight", async () => {
    await linked();
    qdit.state.docLinks = [];
    qdit.state.projects = [];
    await expect(unlinkProject({ admin, client: qdit.client, docId: DOC })).rejects.toMatchObject({ code: "QDIT_UNCONFIRMED" });
    expect(db.doc_project_links).toHaveLength(1);
  });
});

describe("createMilestoneLink (D-06, D-08, D-11)", () => {
  it("creates a milestone titled after the heading, with the note's chain version", async () => {
    await linked();
    const row = await milestoneOn("# Intro\n## Escrow contract", "h1");
    const m = qdit.state.milestones[0];
    expect(m).toMatchObject({ title: "Escrow contract", link: { doc_id: DOC, node_id: "h1", doc_version: 3 } });
    expect(row).toMatchObject({
      node_id: "h1",
      node_label: "Escrow contract",
      qdit_project_id: PROJECT,
      qdit_milestone_id: m.id,
      qdit_link_id: m.link!.id,
      qdit_state: "linked",
      qdit_doc_version: 3,
    });
  });

  it("sends a null doc_version for a note that was never anchored", async () => {
    await linked();
    chainVersion.mockResolvedValueOnce(null);
    await milestoneOn("# A", "h0");
    expect(qdit.state.milestones[0].link!.doc_version).toBeNull();
  });

  it("needs the note linked to a project first", async () => {
    await expect(milestoneOn("# A", "h0")).rejects.toMatchObject({ code: "NOT_LINKED" });
  });

  it("only links headings: never the root or a concept node", async () => {
    await linked();
    await expect(milestoneOn("# A", "root")).rejects.toMatchObject({ code: "NOT_A_HEADING" });
    await expect(milestoneOn("# A", "c1")).rejects.toMatchObject({ code: "NOT_A_HEADING" });
    expect(qdit.calls).not.toContain("POST /milestones");
  });

  it("refuses a heading that is not in the saved note", async () => {
    await linked();
    await expect(milestoneOn("# A", "h4")).rejects.toMatchObject({ code: "STALE_HEADING" });
  });

  it("refuses a heading that already has a link of any provider (D-08)", async () => {
    await linked();
    db.node_links.push({ id: "gh", document_id: DOC, node_id: "h0", node_label: "A", provider: "github", repo: "a/b", number: 1 });
    await expect(milestoneOn("# A", "h0")).rejects.toMatchObject({ code: "HEADING_TAKEN" });
    expect(qdit.calls).not.toContain("POST /milestones");
  });

  it("recovers a create that reached qdit before (node_already_linked)", async () => {
    await linked();
    await milestoneOn("# A", "h0");
    const first = qdit.state.milestones[0];
    db.node_links = [];
    const row = await milestoneOn("# A", "h0");
    expect(qdit.state.milestones).toHaveLength(1);
    expect(row.qdit_milestone_id).toBe(first.id);
  });

  it("does not take over a milestone whose doqtri row moved off the heading before qdit heard", async () => {
    await linked();
    const beta = await milestoneOn("# Beta", "h0");
    // A heading inserted above: doqtri's row moves to h1 at once, qdit is
    // told later (here, never: the sync has not run).
    db.documents[0].version = 6;
    await remapAfterSave(admin, { docId: DOC, version: 6, title: "Plan", markdown: "# Alpha\n# Beta", previousMarkdown: "# Beta" });
    expect(qditRow(beta.id)).toMatchObject({ node_id: "h1", qdit_state: "pending" });
    qdit.calls.length = 0;

    await expect(milestoneOn("# Alpha\n# Beta", "h0")).rejects.toMatchObject({ status: 409, code: "QDIT_CONFLICT" });
    // Beta's link is untouched in qdit and in doqtri.
    expect(qdit.calls.some((c) => c.startsWith("DELETE /links"))).toBe(false);
    expect(qdit.state.milestones[0].link).toMatchObject({ id: beta.qdit_link_id, node_id: "h0" });
    expect(db.node_links).toHaveLength(1);
    // Once qdit has caught up, the create goes through.
    await syncQditLinks({ admin, client: qdit.client, docId: DOC, chainVersion });
    const alpha = await milestoneOn("# Alpha\n# Beta", "h0");
    expect(alpha.qdit_milestone_id).not.toBe(beta.qdit_milestone_id);
    expect(qdit.state.milestones.find((m) => m.id === beta.qdit_milestone_id)!.link).toMatchObject({ node_id: "h1" });
  });

  it("takes back only a link it made itself when the heading is taken meanwhile", async () => {
    await linked();
    // Another editor's link lands on h0 between the free-heading check and the insert.
    const insert = admin.from;
    let raced = false;
    admin.from = ((table: string) => {
      const q = insert(table as never);
      if (table === "node_links" && !raced) {
        const orig = q.insert;
        q.insert = ((row: Record<string, unknown>) => {
          raced = true;
          db.node_links.push({ id: "gh", document_id: DOC, node_id: "h0", node_label: "A", provider: "github", repo: "a/b", number: 1 });
          return orig(row);
        }) as typeof q.insert;
      }
      return q;
    }) as typeof admin.from;
    await expect(milestoneOn("# A", "h0")).rejects.toMatchObject({ code: "HEADING_TAKEN" });
    admin.from = insert;
    expect(qdit.state.milestones).toHaveLength(1);
    expect(qdit.state.milestones[0].link).toBeNull();
  });

  it("refuses a heading whose saved text is not the one picked (positional ids, R-03)", async () => {
    await linked();
    await expect(
      createMilestoneLink({ admin, client: qdit.client, userId: USER, doc: doc("# Intro\n# Beta"), nodeId: "h0", nodeLabel: "Alpha", chainVersion }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_HEADING" });
    expect(qdit.calls).not.toContain("POST /milestones");
    const row = await createMilestoneLink({ admin, client: qdit.client, userId: USER, doc: doc("# Intro\n# Beta"), nodeId: "h1", nodeLabel: " Beta ", chainVersion });
    expect(row.node_label).toBe("Beta");
  });

  it("explains a project link that qdit no longer has", async () => {
    await linked();
    qdit.state.docLinks = [];
    await expect(milestoneOn("# A", "h0")).rejects.toMatchObject({ code: "QDIT_DOC_NOT_LINKED" });
  });

  it("turns a missing connection into a reconnect message", async () => {
    await linked();
    qdit.client.createMilestone = async () => {
      throw new QditError("not_connected", "Connect your qdit account in your profile first.");
    };
    await expect(milestoneOn("# A", "h0")).rejects.toMatchObject({ status: 409, code: "QDIT_NOT_CONNECTED" });
  });
});

describe("adoptMilestoneLink", () => {
  it("takes over a milestone qdit links to this note, moving and retitling it", async () => {
    await linked();
    await milestoneOn("# Old", "h0");
    const m = qdit.state.milestones[0];
    db.node_links = [];
    const row = await adoptMilestoneLink({
      admin, client: qdit.client, userId: USER, doc: doc("# Intro\n# New title"), nodeId: "h1", milestoneId: m.id, chainVersion,
    });
    expect(m.link).toMatchObject({ node_id: "h1", node_label: "New title" });
    expect(m.title).toBe("New title");
    expect(row).toMatchObject({ node_id: "h1", node_label: "New title", qdit_state: "linked" });
  });

  it("refuses a milestone qdit has not linked (no v1 call links one)", async () => {
    await linked();
    qdit.state.milestones.push({ id: "m-free", project: PROJECT, title: "Free", link: null });
    await expect(
      adoptMilestoneLink({ admin, client: qdit.client, userId: USER, doc: doc("# A"), nodeId: "h0", milestoneId: "m-free", chainVersion }),
    ).rejects.toMatchObject({ code: "QDIT_UNLINKED_MILESTONE" });
  });

  it("refuses a milestone of another project", async () => {
    await linked();
    qdit.state.milestones.push({ id: "m-other", project: OTHER_PROJECT, title: "X", link: null });
    await expect(
      adoptMilestoneLink({ admin, client: qdit.client, userId: USER, doc: doc("# A"), nodeId: "h0", milestoneId: "m-other", chainVersion }),
    ).rejects.toMatchObject({ code: "OTHER_PROJECT" });
  });

  it("refuses a milestone already linked here", async () => {
    await linked();
    const row = await milestoneOn("# A\n# B", "h0");
    await expect(
      adoptMilestoneLink({ admin, client: qdit.client, userId: USER, doc: doc("# A\n# B"), nodeId: "h1", milestoneId: row.qdit_milestone_id, chainVersion }),
    ).rejects.toMatchObject({ code: "ALREADY_LINKED" });
  });
});

describe("unlinkMilestone", () => {
  it("deletes qdit's link and the row; the milestone stays", async () => {
    await linked();
    const row = await milestoneOn("# A", "h0");
    await unlinkMilestone({ admin, client: qdit.client, row });
    expect(db.node_links).toEqual([]);
    expect(qdit.state.milestones).toHaveLength(1);
    expect(qdit.state.milestones[0].link).toBeNull();
  });

  it("takes a 404 as done when the milestone shows no such link", async () => {
    await linked();
    const row = await milestoneOn("# A", "h0");
    qdit.state.milestones[0].link = null;
    await unlinkMilestone({ admin, client: qdit.client, row });
    expect(db.node_links).toEqual([]);
  });

  it("keeps the row when qdit cannot confirm", async () => {
    await linked();
    const row = await milestoneOn("# A", "h0");
    qdit.state.hidden = new Set([row.qdit_milestone_id]);
    await expect(unlinkMilestone({ admin, client: qdit.client, row })).rejects.toMatchObject({ code: "QDIT_UNCONFIRMED" });
    expect(db.node_links).toHaveLength(1);
  });
});

describe("remapAfterSave and syncQditLinks (R-03, D-12, D-21)", () => {
  async function save(previous: string | null, markdown: string) {
    db.documents[0].version = (db.documents[0].version as number) + 1;
    const result = await remapAfterSave(admin, {
      docId: DOC,
      version: db.documents[0].version as number,
      title: "Plan",
      markdown,
      previousMarkdown: previous,
    });
    const synced = await syncQditLinks({ admin, client: qdit.client, docId: DOC, chainVersion });
    return { result, synced };
  }

  it("a renamed heading renames the milestone (doqtri wins)", async () => {
    await linked();
    const row = await milestoneOn("# Intro\n# Escrow", "h1");
    const { result, synced } = await save("# Intro\n# Escrow", "# Intro\n# Escrow contract");
    expect(result.qditPending).toBe(true);
    expect(synced).toMatchObject({ skipped: false, synced: 1, failed: [] });
    expect(qdit.state.milestones[0]).toMatchObject({ title: "Escrow contract", link: { node_label: "Escrow contract" } });
    expect(qditRow(row.id)).toMatchObject({ node_id: "h1", node_label: "Escrow contract", qdit_state: "linked" });
    expect(qdit.calls).toContain(`PATCH /milestones/${row.qdit_milestone_id} Escrow contract`);
  });

  it("an inserted heading moves the link in doqtri and in qdit, with the new chain version", async () => {
    await linked();
    const row = await milestoneOn("# Escrow", "h0");
    chainVersion.mockResolvedValue(4);
    await save("# Escrow", "# Intro\n# Escrow");
    expect(qditRow(row.id)).toMatchObject({ node_id: "h1", qdit_state: "linked", qdit_doc_version: 4 });
    expect(qdit.state.milestones[0].link).toMatchObject({ node_id: "h1", doc_version: 4 });
    // A move sends no label, and the title did not change.
    expect(qdit.calls.filter((c) => c.startsWith("PATCH /milestones"))).toEqual([]);
    chainVersion.mockResolvedValue(3);
  });

  it("two headings swapped: both links follow, and qdit gets there through a step aside", async () => {
    await linked();
    const a = await milestoneOn("# A\n# B", "h0");
    const b = await milestoneOn("# A\n# B", "h1");
    const { synced } = await save("# A\n# B", "# B\n# A");
    expect(synced.synced).toBe(2);
    expect(qditRow(a.id)).toMatchObject({ node_id: "h1", qdit_state: "linked" });
    expect(qditRow(b.id)).toMatchObject({ node_id: "h0", qdit_state: "linked" });
    const byId = new Map(qdit.state.milestones.map((m) => [m.id, m.link!.node_id]));
    expect(byId.get(a.qdit_milestone_id)).toBe("h1");
    expect(byId.get(b.qdit_milestone_id)).toBe("h0");
  });

  it("a deleted heading is flagged broken, the milestone kept, and the links after it move up", async () => {
    await linked();
    const b = await milestoneOn("# A\n# B\n# C", "h1");
    const c = await milestoneOn("# A\n# B\n# C", "h2");
    await save("# A\n# B\n# C", "# A\n# C");
    expect(qditRow(b.id).qdit_state).toBe("broken");
    expect(qditRow(c.id)).toMatchObject({ node_id: "h1", qdit_state: "linked" });
    // qdit had B on h1; C's move found it there and moved it out of the way.
    expect(qdit.state.milestones.find((m) => m.id === c.qdit_milestone_id)!.link!.node_id).toBe("h1");
    expect(qdit.state.milestones).toHaveLength(2);
  });

  it("a duplicated heading makes the link ambiguous and tells qdit nothing", async () => {
    await linked();
    const row = await milestoneOn("# Intro\n# Tests", "h1");
    qdit.calls.length = 0;
    // Without the old text (labels only), two "Tests" cannot be told apart.
    await save(null, "# Tests\n# Tests copy\n# Tests");
    expect(qditRow(row.id).qdit_state).toBe("ambiguous");
    expect(qdit.calls).toEqual([]);
  });

  it("relinking an ambiguous link points qdit at the chosen heading", async () => {
    await linked();
    const row = await milestoneOn("# Intro\n# Tests", "h1");
    await save(null, "# Tests\n# Intro\n# Tests");
    expect(qditRow(row.id).qdit_state).toBe("ambiguous");
    await relinkMilestone({ admin, doc: doc("# Tests\n# Intro\n# Tests"), row: qditRow(row.id), nodeId: "h2" });
    await syncQditLinks({ admin, client: qdit.client, docId: DOC, chainVersion });
    expect(qditRow(row.id)).toMatchObject({ node_id: "h2", qdit_state: "linked" });
    expect(qdit.state.milestones[0].link!.node_id).toBe("h2");
  });

  it("a remap worked out before a later save is dropped", async () => {
    await linked();
    const row = await milestoneOn("# A", "h0");
    const result = await remapAfterSave(admin, {
      docId: DOC,
      version: 4,
      title: "Plan",
      markdown: "# New\n# A",
      previousMarkdown: "# A",
    });
    expect(result.changed).toBe(0);
    expect(qditRow(row.id).node_id).toBe("h0");
  });

  it("GitHub links move with their heading and keep their label", async () => {
    db.node_links.push({ id: "gh", document_id: DOC, node_id: "h0", node_label: "A", provider: "github", repo: "a/b", number: 1, qdit_state: null });
    db.documents[0].version = 6;
    await remapAfterSave(admin, { docId: DOC, version: 6, title: "Plan", markdown: "# New\n# A", previousMarkdown: "# A" });
    expect(db.node_links[0]).toMatchObject({ node_id: "h1", node_label: "A", qdit_state: null });
  });

  it("a save that changes no linked heading writes nothing", async () => {
    await linked();
    await milestoneOn("# A\n# B", "h0");
    admin.rpc.mockClear();
    const result = await remapAfterSave(admin, { docId: DOC, version: 5, title: "Plan", markdown: "# A\n# B\ntext", previousMarkdown: "# A\n# B" });
    expect(result).toEqual({ changed: 0, qditPending: false });
    expect(admin.rpc).not.toHaveBeenCalledWith("apply_node_link_remap", expect.anything());
  });

  it("a failure leaves the link pending for Retry", async () => {
    await linked();
    const row = await milestoneOn("# Escrow", "h0");
    const rename = qdit.client.renameMilestone;
    qdit.client.renameMilestone = async () => {
      throw new QditError("unavailable", "down", { status: 503 });
    };
    const { synced } = await save("# Escrow", "# Escrow v2");
    expect(synced.failed).toEqual([{ id: row.id, message: "qdit couldn't be reached. Try again." }]);
    expect(qditRow(row.id).qdit_state).toBe("pending");

    qdit.client.renameMilestone = rename;
    const retry = await syncQditLinks({ admin, client: qdit.client, docId: DOC, chainVersion });
    expect(retry.synced).toBe(1);
    expect(qdit.state.milestones[0].title).toBe("Escrow v2");
  });

  it("a link qdit no longer holds becomes broken", async () => {
    await linked();
    const row = await milestoneOn("# A", "h0");
    qdit.state.milestones[0].link = null;
    await save("# A", "# A2");
    expect(qditRow(row.id).qdit_state).toBe("broken");
  });

  it("a sync that finds another running stops at once", async () => {
    await linked();
    await milestoneOn("# A", "h0");
    db.doc_project_links[0].sync_lease = "someone-else";
    const result = await syncQditLinks({ admin, client: qdit.client, docId: DOC, chainVersion });
    expect(result.skipped).toBe(true);
  });

  it("does not mark a row linked that changed while qdit was being told", async () => {
    await linked();
    const row = await milestoneOn("# A", "h0");
    await save("# A", "# A2");
    // Simulate a second save landing during the first sync's rename.
    db.node_links[0] = { ...db.node_links[0], node_label: "A3", qdit_state: "pending" };
    const rename = qdit.client.renameMilestone;
    let first = true;
    qdit.client.renameMilestone = async (id, title) => {
      const m = await rename(id, title);
      if (first) {
        first = false;
        db.node_links[0] = { ...db.node_links[0], node_label: "A4" };
      }
      return m;
    };
    await syncQditLinks({ admin, client: qdit.client, docId: DOC, chainVersion });
    expect(qditRow(row.id)).toMatchObject({ node_label: "A4", qdit_state: "linked" });
    expect(qdit.state.milestones[0].title).toBe("A4");
  });
});

describe("LinkingError", () => {
  it("carries a status and code", () => {
    const e = new LinkingError(409, "x", "Y");
    expect([e.status, e.code, e.message]).toEqual([409, "Y", "x"]);
  });
});
