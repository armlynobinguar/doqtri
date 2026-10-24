import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRole } from "@/lib/workspace-roles";

/*
 * The qdit linking routes (WP-2.5): who may call which, and that each hands
 * the right arguments to lib/integrations/qdit-linking.ts (tested on its
 * own against an in-memory qdit) and maps its errors.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://doqtri.test";
});

const DOC = "30000000-0000-4000-8000-000000000010";
const PROJECT = "3F6C2A1E-8B4D-4C7E-9A10-2D5B7E9F1C34";
const LINK = "40000000-0000-4000-8000-000000000002";
const ME = "00000000-0000-4000-8000-000000000003";

let user: { id: string } | null = { id: ME };
let role: WorkspaceRole | null = "admin";
let configured = true;
let linkRow: Record<string, unknown> | null = null;
let adminReads = 0;

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) } }),
  createSupabaseAdminClient: () => ({
    from: () => {
      adminReads += 1;
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: linkRow, error: null }) };
      return query;
    },
  }),
}));

const loadMemberDocument = vi.fn(async (_admin: unknown, params: { minRole: WorkspaceRole }) => {
  const rank = { viewer: 1, editor: 2, admin: 3, owner: 4 };
  if (!role) return { ok: false, reason: "not_found" };
  if (rank[role] < rank[params.minRole]) return { ok: false, reason: "forbidden", role };
  return {
    ok: true,
    role,
    doc: { id: DOC, workspace_id: "ws", user_id: ME, title: "Plan", markdown: "# A" },
  };
});
vi.mock("@/lib/workspace-docs", () => ({ loadMemberDocument: (...args: [unknown, { minRole: WorkspaceRole }]) => loadMemberDocument(...args) }));

vi.mock("@/lib/stellar/contract-client", () => ({ DoqtriRegistry: { getDocument: async () => ({ version: 2 }) } }));

const qditClient = { listAllProjects: vi.fn() };
vi.mock("@/lib/integrations/qdit-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/qdit-client")>()),
  qditServerSetup: () => (configured ? { config: {}, tokenKey: Buffer.alloc(32), store: {} } : null),
  createQditClient: () => qditClient,
}));

const lib = vi.hoisted(() => ({
  linkProject: vi.fn(),
  unlinkProject: vi.fn(),
  createMilestoneLink: vi.fn(),
  adoptMilestoneLink: vi.fn(),
  relinkMilestone: vi.fn(),
  unlinkMilestone: vi.fn(),
  syncQditLinks: vi.fn(),
}));
vi.mock("@/lib/integrations/qdit-linking", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/qdit-linking")>()),
  ...lib,
}));

const { LinkingError } = await import("@/lib/integrations/qdit-linking");
const project = await import("./docs/[docId]/project/route");
const milestones = await import("./docs/[docId]/milestones/route");
const sync = await import("./docs/[docId]/sync/route");
const links = await import("./links/[id]/route");
const projects = await import("./projects/route");

const docCtx = (docId = DOC) => ({ params: Promise.resolve({ docId }) }) as never;
const linkCtx = (id = LINK) => ({ params: Promise.resolve({ id }) }) as never;
const req = (body?: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "1");
  user = { id: ME };
  role = "admin";
  configured = true;
  linkRow = { document_id: DOC, id: LINK, node_id: "h0", node_label: "A", qdit_link_id: "l", qdit_milestone_id: "m" };
  adminReads = 0;
  loadMemberDocument.mockClear();
  for (const fn of Object.values(lib)) fn.mockReset();
  qditClient.listAllProjects.mockReset();
});

describe("with the integration off", () => {
  it("every route is 404, and nothing is read", async () => {
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "");
    const answers = await Promise.all([
      project.POST(req({ projectId: PROJECT }), docCtx()),
      project.DELETE(req(), docCtx()),
      milestones.POST(req({ nodeId: "h0" }), docCtx()),
      sync.POST(req(), docCtx()),
      links.DELETE(req(), linkCtx()),
      links.PATCH(req({ nodeId: "h0" }), linkCtx()),
      projects.GET(),
    ]);
    expect(answers.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    expect(loadMemberDocument).not.toHaveBeenCalled();
  });
});

describe("POST and DELETE /docs/[docId]/project (D-10)", () => {
  it("refuses a signed-out caller", async () => {
    user = null;
    expect((await project.POST(req({ projectId: PROJECT }), docCtx())).status).toBe(401);
  });

  it("needs an admin or owner of the note's workspace", async () => {
    role = "editor";
    const res = await project.POST(req({ projectId: PROJECT }), docCtx());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/admin or owner of this workspace/);
    expect(loadMemberDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ minRole: "admin" }));
    role = "editor";
    expect((await project.DELETE(req(), docCtx())).status).toBe(403);
    expect(lib.linkProject).not.toHaveBeenCalled();
    expect(lib.unlinkProject).not.toHaveBeenCalled();
  });

  it("hides a note outside the caller's workspaces", async () => {
    role = null;
    expect((await project.POST(req({ projectId: PROJECT }), docCtx())).status).toBe(404);
    expect((await project.POST(req({ projectId: PROJECT }), docCtx("not-a-uuid"))).status).toBe(404);
  });

  it("needs a project id", async () => {
    expect((await project.POST(req({ projectId: "x" }), docCtx())).status).toBe(400);
    expect(lib.linkProject).not.toHaveBeenCalled();
  });

  it("links with doqtri's own origin (D-45), the project id lowercased", async () => {
    lib.linkProject.mockResolvedValue({ document_id: DOC, project_id: PROJECT.toLowerCase() });
    const res = await project.POST(req({ projectId: PROJECT }), docCtx());
    expect(res.status).toBe(200);
    expect(lib.linkProject).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ME,
        projectId: PROJECT.toLowerCase(),
        siteUrl: "https://doqtri.test",
        doc: expect.objectContaining({ id: DOC, title: "Plan" }),
      }),
    );
  });

  it("answers a LinkingError with its status, code and Retry-After", async () => {
    lib.linkProject.mockRejectedValue(new LinkingError(429, "qdit is busy.", "QDIT_RATE_LIMITED", 30));
    const res = await project.POST(req({ projectId: PROJECT }), docCtx());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(await res.json()).toEqual({ error: "qdit is busy.", code: "QDIT_RATE_LIMITED" });
  });

  it("says when qdit is not set up", async () => {
    configured = false;
    const res = await project.POST(req({ projectId: PROJECT }), docCtx());
    expect(res.status).toBe(503);
  });

  it("unlinks and returns the removed link ids", async () => {
    lib.unlinkProject.mockResolvedValue({ removedLinkIds: ["a"] });
    const res = await project.DELETE(req(), docCtx());
    expect(await res.json()).toEqual({ removed_link_ids: ["a"] });
  });
});

describe("POST /docs/[docId]/milestones", () => {
  it("needs an editor", async () => {
    role = "viewer";
    const res = await milestones.POST(req({ nodeId: "h0" }), docCtx());
    expect(res.status).toBe(403);
    expect(loadMemberDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ minRole: "editor" }));
  });

  it("creates a milestone from a heading", async () => {
    role = "editor";
    lib.createMilestoneLink.mockResolvedValue({ id: "row" });
    const res = await milestones.POST(req({ nodeId: "h0" }), docCtx());
    expect(res.status).toBe(201);
    expect(lib.createMilestoneLink).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "h0", userId: ME }));
    expect(lib.adoptMilestoneLink).not.toHaveBeenCalled();
  });

  it("passes the heading's text along, for the saved-note check", async () => {
    role = "editor";
    lib.createMilestoneLink.mockResolvedValue({ id: "row" });
    await milestones.POST(req({ nodeId: "h0", nodeLabel: "Escrow" }), docCtx());
    expect(lib.createMilestoneLink).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "h0", nodeLabel: "Escrow" }));
  });

  it("takes over an existing milestone when given its id", async () => {
    role = "editor";
    lib.adoptMilestoneLink.mockResolvedValue({ id: "row" });
    const res = await milestones.POST(req({ nodeId: "h0", milestoneId: PROJECT }), docCtx());
    expect(res.status).toBe(201);
    expect(lib.adoptMilestoneLink).toHaveBeenCalledWith(expect.objectContaining({ milestoneId: PROJECT.toLowerCase() }));
  });

  it("refuses a missing heading or a malformed milestone id", async () => {
    expect((await milestones.POST(req({}), docCtx())).status).toBe(400);
    expect((await milestones.POST(req({ nodeId: "h0", milestoneId: "abc" }), docCtx())).status).toBe(400);
  });
});

describe("POST /docs/[docId]/sync", () => {
  it("runs the sync as the caller", async () => {
    role = "editor";
    lib.syncQditLinks.mockResolvedValue({ skipped: false, synced: 1, failed: [] });
    const res = await sync.POST(req(), docCtx());
    expect(await res.json()).toEqual({ skipped: false, synced: 1, failed: [] });
  });
});

describe("DELETE and PATCH /links/[id]", () => {
  it("answers a signed-out caller the same for any id, before looking the link up", async () => {
    user = null;
    expect((await links.DELETE(req(), linkCtx())).status).toBe(401);
    linkRow = null;
    expect((await links.DELETE(req(), linkCtx())).status).toBe(401);
    expect((await links.PATCH(req({ nodeId: "h1" }), linkCtx())).status).toBe(401);
    expect(adminReads).toBe(0);
  });

  it("does not find a link that is not a qdit link", async () => {
    linkRow = null;
    expect((await links.DELETE(req(), linkCtx())).status).toBe(404);
    expect(loadMemberDocument).not.toHaveBeenCalled();
  });

  it("does not find a link on a note the caller cannot see", async () => {
    role = null;
    const res = await links.DELETE(req(), linkCtx());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Link not found");
  });

  it("refuses a viewer", async () => {
    role = "viewer";
    expect((await links.DELETE(req(), linkCtx())).status).toBe(403);
    expect(lib.unlinkMilestone).not.toHaveBeenCalled();
  });

  it("unlinks for an editor", async () => {
    role = "editor";
    const res = await links.DELETE(req(), linkCtx());
    expect(res.status).toBe(200);
    expect(lib.unlinkMilestone).toHaveBeenCalledWith(expect.objectContaining({ row: linkRow }));
  });

  it("relinks to another heading and tells qdit at once", async () => {
    role = "editor";
    lib.relinkMilestone.mockResolvedValue({ id: LINK, node_id: "h2" });
    lib.syncQditLinks.mockResolvedValue({ skipped: false, synced: 0, failed: [{ id: LINK, message: "down" }] });
    const res = await links.PATCH(req({ nodeId: "h2" }), linkCtx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ link: { id: LINK, node_id: "h2" }, failed: [{ id: LINK, message: "down" }] });
    expect(lib.relinkMilestone).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "h2", nodeLabel: undefined }));
    await links.PATCH(req({ nodeId: "h2", nodeLabel: "Escrow" }), linkCtx());
    expect(lib.relinkMilestone).toHaveBeenLastCalledWith(expect.objectContaining({ nodeId: "h2", nodeLabel: "Escrow" }));
  });
});

describe("GET /projects", () => {
  it("lists the user's projects and which they may link", async () => {
    qditClient.listAllProjects.mockResolvedValue([
      { id: "p1", name: "One", slug: "one", status: "active", role: "owner", url: "u" },
      { id: "p2", name: "Two", slug: "two", status: "active", role: "member", url: "u" },
    ]);
    const res = await projects.GET();
    expect(await res.json()).toEqual({
      projects: [
        { id: "p1", name: "One", slug: "one", status: "active", role: "owner", can_link: true },
        { id: "p2", name: "Two", slug: "two", status: "active", role: "member", can_link: false },
      ],
    });
  });

  it("asks a user without a connection to connect", async () => {
    const { QditNotConnectedError } = await import("@/lib/integrations/qdit-client");
    qditClient.listAllProjects.mockRejectedValue(new QditNotConnectedError("none"));
    const res = await projects.GET();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("QDIT_NOT_CONNECTED");
  });
});
