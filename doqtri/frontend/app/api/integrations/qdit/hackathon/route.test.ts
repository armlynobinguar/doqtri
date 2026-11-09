import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRole } from "@/lib/workspace-roles";

/*
 * POST /api/integrations/qdit/hackathon (WP-4.7, D-117): who may send, what
 * the request may say, that the snapshot is built from the active workspace
 * with the session client (and the service role only as sourceClient), that
 * the built body is what is pushed, and how every outcome reads in the
 * dialog. qdit is a fake QditClient; the builder and the client are tested on
 * their own (qdit-hackathon.test.ts, qdit-client.test.ts).
 */

const ME = "00000000-0000-4000-8000-000000000003";
const WS = "10000000-0000-4000-8000-000000000001";
const PROJECT = "3F6C2A1E-8B4D-4C7E-9A10-2D5B7E9F1C34";
const SLUG = "stellar-build-2026";
const BODY = '{"hackathon_slug":"stellar-build-2026","notes":[]}';

let user: { id: string } | null = { id: ME };
let role: WorkspaceRole = "admin";
let configured = true;
let connection: { status: string } | null = { status: "connected" };

const sessionClient = { auth: { getUser: async () => ({ data: { user } }) }, kind: "session" };
const adminClient = { kind: "admin" };
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
  build.mockReset();
  build.mockResolvedValue({ snapshot: {}, body: BODY, warnings: [] });
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
    expect(qdit.pushHackathonSnapshot).toHaveBeenCalledWith(PROJECT.toLowerCase(), BODY);
    expect(await res.json()).toEqual({
      ok: true,
      note_count: 7,
      submission_state: "none",
      qdit_url: `https://qdit.test/hackathons/${SLUG}`,
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
    build.mockResolvedValue({ snapshot: {}, body: BODY, warnings });
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
    [refusal("forbidden", "forbidden"), 403, "QDIT_FORBIDDEN", "You need to be an admin of that qdit project"],
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
    [new QditError("timeout", "late"), 502, "QDIT_UNAVAILABLE", COPY.unavailable],
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
});
