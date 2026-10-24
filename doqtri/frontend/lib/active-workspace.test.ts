import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const adminRpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseAdminClient: () => ({ rpc: adminRpc }),
  createSupabaseServerClient: async () => {
    throw new Error("not used in these tests");
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import { listMyWorkspaces, resolveActiveWorkspace, workspaceForCreate } from "./active-workspace";

type Result = { data: unknown; error: { message: string } | null };

const USER = "11111111-1111-4111-8111-111111111111";
const PERSONAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STRANGER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** Each `from(table)` chain resolves to the next queued result for that table. */
function fakeClient(results: Record<string, Result[]>) {
  const calls: { table: string; select?: string; filters: [string, unknown][] }[] = [];
  const client = {
    from(table: string) {
      const call: (typeof calls)[number] = { table, filters: [] };
      calls.push(call);
      const next = () => Promise.resolve((results[table] ?? []).shift() ?? { data: null, error: null });
      const chain: Record<string, unknown> = {
        select: (columns: string) => {
          call.select = columns;
          return chain;
        },
        eq: (col: string, val: unknown) => {
          call.filters.push([col, val]);
          return chain;
        },
        maybeSingle: next,
        then: (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) => next().then(resolve, reject),
      };
      return chain;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const memberships = (rows: { id: string; name: string; personal: boolean; role: string; createdBy: string | null }[]) => ({
  data: rows.map((r) => ({
    role: r.role,
    workspaces: { id: r.id, name: r.name, is_personal: r.personal, created_by: r.createdBy },
  })),
  error: null,
});

const BOTH = memberships([
  { id: TEAM, name: "Acme", personal: false, role: "viewer", createdBy: "someone" },
  { id: PERSONAL, name: "Ana", personal: true, role: "owner", createdBy: USER },
]);

beforeEach(() => adminRpc.mockReset());

describe("listMyWorkspaces", () => {
  it("lists the user's memberships, own personal workspace first", async () => {
    const { client, calls } = fakeClient({ workspace_members: [BOTH] });
    const list = await listMyWorkspaces(client, USER);
    expect(list.map((w) => [w.id, w.role, w.personal, w.mine])).toEqual([
      [PERSONAL, "owner", true, true],
      [TEAM, "viewer", false, false],
    ]);
    expect(calls[0].filters).toEqual([["user_id", USER]]);
  });

  it("skips memberships whose workspace it cannot see", async () => {
    const { client } = fakeClient({
      workspace_members: [{ data: [{ role: "editor", workspaces: null }], error: null }],
    });
    expect(await listMyWorkspaces(client, USER)).toEqual([]);
  });

  it("throws when the read fails", async () => {
    const { client } = fakeClient({ workspace_members: [{ data: null, error: { message: "down" } }] });
    await expect(listMyWorkspaces(client, USER)).rejects.toThrow(/down/);
  });
});

describe("resolveActiveWorkspace", () => {
  it("shows the requested workspace to a member", async () => {
    const { client } = fakeClient({ workspace_members: [BOTH] });
    const { active, workspaces } = await resolveActiveWorkspace(client, USER, TEAM);
    expect(active.id).toBe(TEAM);
    expect(workspaces).toHaveLength(2);
  });

  it("defaults to the personal workspace", async () => {
    const { client } = fakeClient({ workspace_members: [BOTH] });
    expect((await resolveActiveWorkspace(client, USER, null)).active.id).toBe(PERSONAL);
  });

  it("falls back to the personal workspace for one the user is not in", async () => {
    const { client } = fakeClient({ workspace_members: [BOTH] });
    expect((await resolveActiveWorkspace(client, USER, STRANGER)).active.id).toBe(PERSONAL);
  });

  it("repairs a missing personal workspace, then shows it", async () => {
    const { client } = fakeClient({
      workspace_members: [
        memberships([{ id: TEAM, name: "Acme", personal: false, role: "viewer", createdBy: "someone" }]),
        BOTH,
      ],
      workspaces: [{ data: null, error: null }],
    });
    adminRpc.mockResolvedValue({ data: PERSONAL, error: null });
    expect((await resolveActiveWorkspace(client, USER, null)).active.id).toBe(PERSONAL);
    expect(adminRpc).toHaveBeenCalledWith("ensure_personal_workspace", { p_user_id: USER });
  });
});

describe("workspaceForCreate", () => {
  it("creates in the workspace the request names, for an editor", async () => {
    const { client, calls } = fakeClient({ workspace_members: [{ data: { role: "editor" }, error: null }] });
    expect(await workspaceForCreate(client, USER, { requested: TEAM })).toEqual({ ok: true, workspaceId: TEAM });
    expect(calls[0].filters).toEqual([
      ["workspace_id", TEAM],
      ["user_id", USER],
    ]);
  });

  it("prefers the request over the cookie", async () => {
    const { client, calls } = fakeClient({ workspace_members: [{ data: { role: "owner" }, error: null }] });
    await workspaceForCreate(client, USER, { requested: TEAM, cookie: STRANGER });
    expect(calls[0].filters[0]).toEqual(["workspace_id", TEAM]);
  });

  it("refuses a viewer (D-14)", async () => {
    const { client } = fakeClient({ workspace_members: [{ data: { role: "viewer" }, error: null }] });
    expect(await workspaceForCreate(client, USER, { requested: TEAM })).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a named workspace the user is not in", async () => {
    const { client } = fakeClient({ workspace_members: [{ data: null, error: null }] });
    expect(await workspaceForCreate(client, USER, { requested: STRANGER })).toMatchObject({ ok: false, status: 404 });
  });

  it("uses the cookie's workspace when the request names none", async () => {
    const { client } = fakeClient({ workspace_members: [{ data: { role: "admin" }, error: null }] });
    expect(await workspaceForCreate(client, USER, { cookie: TEAM })).toEqual({ ok: true, workspaceId: TEAM });
  });

  it("falls back to the personal workspace from a stale cookie", async () => {
    const { client } = fakeClient({
      workspace_members: [{ data: null, error: null }],
      workspaces: [{ data: { id: PERSONAL }, error: null }],
    });
    expect(await workspaceForCreate(client, USER, { cookie: STRANGER })).toEqual({ ok: true, workspaceId: PERSONAL });
  });

  it("ignores a request value that is not a workspace id", async () => {
    const { client, calls } = fakeClient({ workspaces: [{ data: { id: PERSONAL }, error: null }] });
    expect(await workspaceForCreate(client, USER, { requested: "../x" })).toEqual({ ok: true, workspaceId: PERSONAL });
    expect(calls.map((c) => c.table)).toEqual(["workspaces"]);
  });
});
