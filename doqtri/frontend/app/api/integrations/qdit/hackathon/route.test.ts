import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRole } from "@/lib/workspace-roles";

/*
 * POST /api/integrations/qdit/hackathon (WP-4.7, D-117): who may send, what
 * the request may say, that the snapshot is built from the active workspace
 * with the session client (and the service role only as sourceClient), that
 * the built body is what is pushed, and how every outcome reads in the
 * dialog. qdit is a fake QditClient; the builder and the client are tested on
 * their own (qdit-hackathon.test.ts, qdit-client.test.ts).
 *
 * Each press also stores one public mindmap link (DOQ-53) through a fake
 * service-role client, and the body qdit receives names it.
 */

const ME = "00000000-0000-4000-8000-000000000003";
const WS = "10000000-0000-4000-8000-000000000001";
const PROJECT = "3F6C2A1E-8B4D-4C7E-9A10-2D5B7E9F1C34";
const SLUG = "stellar-build-2026";
const SNAPSHOT = {
  hackathon_slug: SLUG,
  snapshot_id: "50000000-0000-4000-8000-000000000005",
  workspace_id: WS,
  generated_at: "2026-11-20T15:04:05.000Z",
  notes: [],
  global_mindmap: {
    nodes: [{ id: "concept:launch", label: "Launch", kind: "concept", depth: 1, doc_ids: [] }],
    links: [],
  },
};
const BODY = JSON.stringify(SNAPSHOT);
const SHARE_ID = "40000000-0000-4000-8000-000000000004";
const SITE = vi.hoisted(() => ({ url: "https://doqtri.test/" }));
vi.mock("@/lib/site-url", () => ({
  get SITE_URL() {
    return SITE.url;
  },
}));

let user: { id: string } | null = { id: ME };
let role: WorkspaceRole = "admin";
let configured = true;
let connection: { status: string } | null = { status: "connected" };

/** The sender's stored `global` style, read by the route with the session client. */
let savedStyle: Record<string, unknown> | null = null;
const sessionClient = {
  auth: { getUser: async () => ({ data: { user } }) },
  kind: "session",
  from: (table: string) => {
    expect(table).toBe("mindmap_styles");
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: savedStyle ? { style: savedStyle, updated_at: "t" } : null, error: null }),
    };
    return query;
  },
};

/** What the route wrote to mindmap_shares as the service role. */
let shareInserts: Record<string, unknown>[] = [];
let shareUpdates: { patch: Record<string, unknown>; id: unknown }[] = [];
let insertError: { message: string } | null = null;
const adminClient = {
  kind: "admin",
  from: (table: string) => {
    expect(table).toBe("mindmap_shares");
    return {
      insert: (row: Record<string, unknown>) => {
        shareInserts.push(row);
        return {
          select: () => ({
            single: async () => (insertError ? { data: null, error: insertError } : { data: { id: SHARE_ID }, error: null }),
          }),
        };
      },
      update: (patch: Record<string, unknown>) => ({
        eq: async (_column: string, id: unknown) => {
          shareUpdates.push({ patch, id });
          return { error: null };
        },
      }),
    };
  },
};

/** The body pushed to qdit, parsed. */
const pushed = () => JSON.parse(qdit.pushHackathonSnapshot.mock.calls[0][1] as string) as Record<string, unknown>;
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => sessionClient,
  createSupabaseAdminClient: () => adminClient,
}));

vi.mock("@/lib/active-workspace", () => ({
  readActiveWorkspaceCookie: async () => WS,
  resolveActiveWorkspace: async () => ({
    active: { id: WS, name: "Team", personal: false, role, mine: false },
    workspaces: [],
  }),
}));

const build = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/qdit-hackathon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/qdit-hackathon")>()),
  buildHackathonSnapshot: build,
}));

const qdit = { pushHackathonSnapshot: vi.fn() };
vi.mock("@/lib/integrations/qdit-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/qdit-client")>()),
  qditServerSetup: () =>
    configured ? { config: {}, tokenKey: Buffer.alloc(32), store: { load: async () => connection } } : null,
  createQditClient: () => qdit,
}));

const { QditError, QditHackathonSnapshotError, QditNotConnectedError } = await import(
  "@/lib/integrations/qdit-client"
);
const { HackathonSnapshotError } = await import("@/lib/integrations/qdit-hackathon");
const { HACKATHON_SEND_COPY: COPY } = await import("@/lib/integrations/qdit-hackathon-send");
const { MINDMAP_SHARE_COPY } = await import("@/lib/mindmap-share");
const { POST } = await import("./route");

const send = (body: unknown = { hackathon: SLUG, project_id: PROJECT }) =>
  POST(
    new Request("http://localhost/api/integrations/qdit/hackathon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const refusal = (kind: ConstructorParameters<typeof QditError>[0], refusal: string, details?: Record<string, unknown>) =>
  new QditHackathonSnapshotError(refusal as never, new QditError(kind, "qdit's own words", { status: 409, details }));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "1");
  vi.stubEnv("NEXT_PUBLIC_QDIT_HACKATHON", "1");
  vi.stubEnv("QDIT_API_BASE_URL", "https://qdit.test/api/v1");
  user = { id: ME };
  role = "admin";
  configured = true;
  connection = { status: "connected" };
  SITE.url = "https://doqtri.test/";
  savedStyle = null;
  shareInserts = [];
  shareUpdates = [];
  insertError = null;
  build.mockReset();
  build.mockResolvedValue({ snapshot: SNAPSHOT, body: BODY, warnings: [] });
  qdit.pushHackathonSnapshot.mockReset();
  qdit.pushHackathonSnapshot.mockResolvedValue({
    id: "8f7e6d5c-4b3a-4c2d-9e1f-0a9b8c7d6e5f",
    note_count: 7,
    received_at: "2026-11-20T15:04:06.120Z",
    submission_state: "none",
  });
});

describe("the flag", () => {
  it.each([
    ["the hackathon flag off", "1", ""],
    ["the integration off", "", "1"],
  ])("is 404 with %s, before reading anything", async (_name, integration, hackathon) => {
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", integration);
    vi.stubEnv("NEXT_PUBLIC_QDIT_HACKATHON", hackathon);
    const res = await send();
    expect(res.status).toBe(404);
    expect(build).not.toHaveBeenCalled();
    expect(qdit.pushHackathonSnapshot).not.toHaveBeenCalled();
  });
});

describe("who may send", () => {
  it("needs a signed-in user", async () => {
    user = null;
    expect((await send()).status).toBe(401);
  });

  it.each(["viewer", "editor"] as const)("refuses a workspace %s with 403 (D-10)", async (r) => {
    role = r;
    const res = await send();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, code: "FORBIDDEN", message: COPY.forbidden });
    expect(build).not.toHaveBeenCalled();
  });

  it("lets an owner send", async () => {
    role = "owner";
    expect((await send()).status).toBe(200);
  });

  it.each([
    ["no connection", null, /Connect your qdit account/],
    ["one that needs a reconnect", { status: "needs_reconnect" }, /Reconnect qdit/],
  ])("refuses %s before building anything", async (_name, conn, message) => {
    connection = conn;
    const res = await send();
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json).toMatchObject({ ok: false, code: "QDIT_NOT_CONNECTED" });
    expect(json.message).toMatch(message);
    expect(build).not.toHaveBeenCalled();
  });

  it("reports a connection lost during the push", async () => {
    qdit.pushHackathonSnapshot.mockRejectedValue(new QditNotConnectedError("needs_reconnect"));
    expect(await (await send()).json()).toMatchObject({ ok: false, code: "QDIT_NOT_CONNECTED" });
  });

  it("is 503 when qdit's public origin is unknown, even for a bare slug", async () => {
    vi.stubEnv("QDIT_API_BASE_URL", "");
    const res = await send();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "QDIT_NOT_CONFIGURED" });
    expect(build).not.toHaveBeenCalled();
  });

  it("is 503 when qdit isn't configured", async () => {
    configured = false;
    expect((await send()).status).toBe(503);
  });
});

describe("the request", () => {
  it.each([
    ["not JSON", "nope"],
    ["no project", { hackathon: SLUG }],
    ["a project that isn't a UUID", { hackathon: SLUG, project_id: "p1" }],
  ])("refuses %s", async (_name, body) => {
    const res = await send(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "BAD_REQUEST" });
  });

  it.each([
    ["an empty link", ""],
    ["uppercase", "Stellar-Build"],
    ["a slug over 64 characters", "a".repeat(65)],
    ["spaces", "stellar build"],
    ["another site's link", "https://evil.test/hackathons/stellar-build-2026"],
    ["a qdit link to another page", "https://qdit.test/projects/stellar-build-2026"],
    ["a link with a bad slug", "https://qdit.test/hackathons/Not_Valid"],
    ["a non-http link", "javascript:alert(1)"],
    ["no hackathon at all", undefined],
  ])("refuses %s as a hackathon", async (_name, hackathon) => {
    const res = await send({ hackathon, project_id: PROJECT });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, code: "BAD_HACKATHON_LINK", message: COPY.badLink });
    expect(build).not.toHaveBeenCalled();
  });

  it.each([
    ["a slug", SLUG],
    ["a qdit link", `https://qdit.test/hackathons/${SLUG}`],
    ["a www link with a trailing slash, query and fragment", `https://www.qdit.test/hackathons/${SLUG}/?tab=entry#top`],
    ["a deeper page of the hackathon", `  https://qdit.test/hackathons/${SLUG}/admin  `],
  ])("takes %s", async (_name, hackathon) => {
    const res = await send({ hackathon, project_id: PROJECT });
    expect(res.status).toBe(200);
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ hackathonSlug: SLUG }));
  });

  it("refuses a workspace that is no longer the active one", async () => {
    const res = await send({ hackathon: SLUG, project_id: PROJECT, workspace_id: "20000000-0000-4000-8000-000000000002" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "WORKSPACE_CHANGED" });
    expect(build).not.toHaveBeenCalled();
  });
});

describe("a send", () => {
  it("builds from the active workspace with the session client, and pushes that exact body once", async () => {
    const res = await send({ hackathon: SLUG, project_id: PROJECT, workspace_id: WS });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(build).toHaveBeenCalledTimes(1);
    const params = build.mock.calls[0][0];
    expect(params).toMatchObject({ workspaceId: WS, hackathonSlug: SLUG });
    expect(params.supabase).toBe(sessionClient);
    expect(params.sourceClient).toBe(adminClient);
    expect(qdit.pushHackathonSnapshot).toHaveBeenCalledTimes(1);
    const json = await res.json();
    const token = String(shareInserts[0]?.token);
    const mindmapUrl = `https://doqtri.test/m/${token}`;
    // The built body, with the link added and nothing else changed.
    expect(qdit.pushHackathonSnapshot).toHaveBeenCalledWith(
      PROJECT.toLowerCase(),
      JSON.stringify({ ...SNAPSHOT, mindmap_url: mindmapUrl }),
    );
    expect(json).toEqual({
      ok: true,
      note_count: 7,
      submission_state: "none",
      qdit_url: `https://qdit.test/hackathons/${SLUG}`,
      mindmap_url: mindmapUrl,
      warnings: [],
    });
  });

  it("passes on submitted_older, for the dialog's resubmit line", async () => {
    qdit.pushHackathonSnapshot.mockResolvedValue({
      id: "8f7e6d5c-4b3a-4c2d-9e1f-0a9b8c7d6e5f",
      note_count: 2,
      received_at: "2026-11-20T15:04:06.120Z",
      submission_state: "submitted_older",
    });
    expect(await (await send()).json()).toMatchObject({ ok: true, note_count: 2, submission_state: "submitted_older" });
    expect(COPY.next.submitted_older).toBe("Resubmit in qdit to include this");
  });

  it("passes on the builder's warnings for the success state", async () => {
    const warnings = ['"Plan" (c2d1e0f9-8a7b-4c6d-9e5f-4a3b2c1d0e9f): its mindmap is over 64 KiB and was not sent.'];
    build.mockResolvedValue({ snapshot: SNAPSHOT, body: BODY, warnings });
    expect(await (await send()).json()).toMatchObject({ ok: true, warnings });
  });

  it("refuses a snapshot over a limit without sending it", async () => {
    build.mockRejectedValue(new HackathonSnapshotError("notes[3].markdown", "too_long", "is too long"));
    const res = await send();
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      ok: false,
      code: "TOO_LARGE",
      message: "Too much to send: remove or shorten notes (notes[3].markdown)",
    });
    expect(qdit.pushHackathonSnapshot).not.toHaveBeenCalled();
  });

  it("answers a failed build with a plain message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    build.mockRejectedValue(new Error("Failed to load the workspace's notes: timeout"));
    const res = await send();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, code: "FAILED", message: COPY.failed });
    log.mockRestore();
  });

  it.each([
    [refusal("conflict", "hackathon_closed"), 409, "HACKATHON_CLOSED", "Submissions are closed"],
    [refusal("conflict", "hackathon_not_open"), 409, "HACKATHON_NOT_OPEN", "This hackathon hasn't opened yet"],
    [
      refusal("conflict", "snapshot_limit"),
      409,
      "SNAPSHOT_LIMIT",
      "This project has reached the snapshot limit for this hackathon",
    ],
    [refusal("conflict", "snapshot_conflict"), 409, "SNAPSHOT_CONFLICT", COPY.conflict],
    [
      refusal("forbidden", "forbidden"),
      403,
      "QDIT_FORBIDDEN",
      "qdit refused this: you need to be an admin of that qdit project. If you are, ask the organisers to check the doqtri connection.",
    ],
    [refusal("not_found", "not_found"), 404, "QDIT_NOT_FOUND", "Hackathon or project not found"],
    [
      refusal("payload_too_large", "too_large"),
      413,
      "TOO_LARGE",
      "Too much to send: remove or shorten notes (body)",
    ],
    [
      refusal("invalid_request", "too_large", { fields: ["body"] }),
      413,
      "TOO_LARGE",
      "Too much to send: remove or shorten notes (body)",
    ],
    [
      refusal("invalid_request", "invalid_snapshot", { fields: ["notes[0].source"] }),
      400,
      "QDIT_REFUSED",
      "qdit didn't accept the snapshot (notes[0].source)",
    ],
    [
      new QditError("rate_limited", "slow", { status: 429, retryAfterSeconds: 7 }),
      429,
      "QDIT_RATE_LIMITED",
      COPY.rateLimited,
    ],
    [new QditError("server", "boom", { status: 500 }), 502, "QDIT_UNAVAILABLE", COPY.unavailable],
    [new QditError("not_configured", "bad client"), 503, "QDIT_NOT_CONFIGURED", COPY.notConfigured],
  ])("maps %o to %i %s", async (error, status, code, message) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    qdit.pushHackathonSnapshot.mockRejectedValue(error);
    const res = await send();
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ ok: false, code, message });
    if (code === "QDIT_RATE_LIMITED") expect(res.headers.get("retry-after")).toBe("7");
    // One press, one push: nothing here retries.
    expect(qdit.pushHackathonSnapshot).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
    for (const line of [...warn.mock.calls, ...log.mock.calls].flat()) expect(String(line)).not.toContain("qdit's own words");
    warn.mockRestore();
    log.mockRestore();
  });

  it("logs only the kind when qdit answers 403", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    qdit.pushHackathonSnapshot.mockRejectedValue(refusal("forbidden", "forbidden"));
    await send();
    expect(warn.mock.calls).toEqual([["[qdit-hackathon] push refused: kind=forbidden"]]);
    warn.mockRestore();
  });

  it.each(["timeout", "network"] as const)(
    "after a %s, says qdit may have it and links the entry, without retrying",
    async (kind) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      qdit.pushHackathonSnapshot.mockRejectedValue(new QditError(kind, "no answer"));
      const res = await send();
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        ok: false,
        code: "QDIT_UNCERTAIN",
        message: "qdit may have received this. Check your entry in qdit before sending again.",
        qdit_url: `https://qdit.test/hackathons/${SLUG}`,
      });
      expect(qdit.pushHackathonSnapshot).toHaveBeenCalledTimes(1);
      expect(log.mock.calls).toEqual([[`[qdit-hackathon] push got no answer: kind=${kind}`]]);
      log.mockRestore();
    },
  );
});

describe("the mindmap link (DOQ-53)", () => {
  it("stores exactly one link per press, and the body qdit receives names its token", async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(shareInserts).toHaveLength(1);
    const [row] = shareInserts;
    expect(row).toEqual({
      token: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      workspace_id: WS,
      created_by: ME,
      snapshot_id: SNAPSHOT.snapshot_id,
      graph: SNAPSHOT.global_mindmap,
      style: null,
    });
    const body = pushed();
    expect(body.mindmap_url).toBe(`https://doqtri.test/m/${row.token}`);
    expect(body.snapshot_id).toBe(row.snapshot_id);
    expect((await res.json()).mindmap_url).toBe(body.mindmap_url);
    expect(shareUpdates).toEqual([]);
  });

  it("makes a new token on every press", async () => {
    await send();
    await send();
    expect(shareInserts).toHaveLength(2);
    expect(shareInserts[0].token).not.toBe(shareInserts[1].token);
  });

  it("stores the sender's global style with it, overrides limited to the map's nodes", async () => {
    savedStyle = { textScale: 1.5, overrides: { "concept:launch": { color: "#ff0000" }, "concept:gone": { hidden: true } } };
    await send();
    const style = shareInserts[0].style as { textScale: number; overrides: Record<string, unknown> };
    expect(style.textScale).toBe(1.5);
    expect(style.overrides).toEqual({ "concept:launch": { color: "#ff0000" } });
  });

  it("builds the link from the site's origin only: https, no trailing slash or path", async () => {
    SITE.url = "https://Doqtri.TEST/some/path/";
    await send();
    expect(pushed().mindmap_url).toBe(`https://doqtri.test/m/${shareInserts[0].token}`);
  });

  it.each([
    ["timeout", new QditError("timeout", "no answer")],
    ["server error", new QditError("server", "boom", { status: 500 })],
    ["refusal", refusal("conflict", "hackathon_closed")],
    ["lost connection", new QditNotConnectedError("needs_reconnect")],
  ])("revokes the link when the push fails (%s), so none stays live", async (_name, error) => {
    const quiet = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {})];
    qdit.pushHackathonSnapshot.mockRejectedValue(error);
    const res = await send();
    expect(res.ok).toBe(false);
    expect(shareInserts).toHaveLength(1);
    expect(shareUpdates).toEqual([{ patch: { revoked_at: expect.any(String) }, id: SHARE_ID }]);
    quiet.forEach((spy) => spy.mockRestore());
  });

  it("sends without a link, and says so, when the link cannot be stored", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    insertError = { message: "relation \"mindmap_shares\" does not exist" };
    const res = await send();
    expect(res.status).toBe(200);
    expect(qdit.pushHackathonSnapshot).toHaveBeenCalledWith(PROJECT.toLowerCase(), BODY);
    expect(await res.json()).toMatchObject({ ok: true, mindmap_url: null, warnings: [MINDMAP_SHARE_COPY.noLink] });
    log.mockRestore();
  });

  it("makes no link on a site that is not https (local dev), and sends as before", async () => {
    SITE.url = "http://localhost:3000";
    const res = await send();
    expect(shareInserts).toEqual([]);
    expect(qdit.pushHackathonSnapshot).toHaveBeenCalledWith(PROJECT.toLowerCase(), BODY);
    expect(await res.json()).toMatchObject({ ok: true, mindmap_url: null, warnings: [MINDMAP_SHARE_COPY.noLink] });
  });

  const oldQdit = (fields: Record<string, string>) =>
    new QditHackathonSnapshotError(
      "invalid_snapshot",
      new QditError("invalid_request", "qdit's own words", { status: 400, details: { fields } }),
    );

  it("resends the first bytes, same snapshot_id, when a qdit before v1.4.0 refuses only the field", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    qdit.pushHackathonSnapshot.mockRejectedValueOnce(oldQdit({ mindmap_url: "unknown field" }));
    const res = await send();
    expect(res.status).toBe(200);
    expect(qdit.pushHackathonSnapshot).toHaveBeenCalledTimes(2);
    expect(JSON.parse(qdit.pushHackathonSnapshot.mock.calls[0][1]).mindmap_url).toMatch(/^https:\/\/doqtri\.test\/m\//);
    expect(qdit.pushHackathonSnapshot.mock.calls[1]).toEqual([PROJECT.toLowerCase(), BODY]);
    expect(shareUpdates).toEqual([{ patch: { revoked_at: expect.any(String) }, id: SHARE_ID }]);
    expect(await res.json()).toMatchObject({ ok: true, mindmap_url: null, warnings: [MINDMAP_SHARE_COPY.noLink] });
    warn.mockRestore();
  });

  it.each([
    ["the link refused for its value", { mindmap_url: "must be https://<doqtri origin>/m/<token>" }],
    ["another field refused too", { mindmap_url: "unknown field", "notes[0].source": "invalid" }],
  ])("does not resend when it is %s, and revokes the link", async (_name, fields) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    qdit.pushHackathonSnapshot.mockRejectedValue(oldQdit(fields));
    const res = await send();
    expect(res.status).toBe(400);
    expect(qdit.pushHackathonSnapshot).toHaveBeenCalledTimes(1);
    expect(shareUpdates).toHaveLength(1);
    warn.mockRestore();
  });

  it("stores no link when the snapshot is refused before sending", async () => {
    build.mockRejectedValue(new HackathonSnapshotError("notes", "too_many", "too many"));
    await send();
    expect(shareInserts).toEqual([]);
  });
});
