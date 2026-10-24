import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const adminRpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseAdminClient: () => ({ rpc: adminRpc }),
}));

import {
  insertWorkspaceDocument,
  loadMemberDocument,
  personalWorkspaceId,
  roleAtLeast,
} from "./workspace-docs";

type Result = { data: unknown; error: { message: string; code?: string } | null };

/**
 * A stand-in client: each `from(table)` chain resolves to the next queued
 * result for that table, and records the filters and inserted rows.
 */
function fakeClient(results: Record<string, Result[]>) {
  const calls: { table: string; filters: [string, string, unknown][]; insert?: unknown }[] = [];
  const client = {
    from(table: string) {
      const call: (typeof calls)[number] = { table, filters: [] };
      calls.push(call);
      const next = () => {
        const queue = results[table] ?? [];
        return Promise.resolve(queue.shift() ?? { data: null, error: null });
      };
      const chain: Record<string, unknown> = {
        select: () => chain,
        insert: (row: unknown) => {
          call.insert = row;
          return chain;
        },
        eq: (col: string, val: unknown) => {
          call.filters.push(["eq", col, val]);
          return chain;
        },
        neq: (col: string, val: unknown) => {
          call.filters.push(["neq", col, val]);
          return chain;
        },
        maybeSingle: next,
        single: next,
        then: (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) => next().then(resolve, reject),
      };
      return chain;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

beforeEach(() => adminRpc.mockReset());

describe("roleAtLeast", () => {
  it("orders viewer < editor < admin < owner", () => {
    expect(roleAtLeast("viewer", "viewer")).toBe(true);
    expect(roleAtLeast("viewer", "editor")).toBe(false);
    expect(roleAtLeast("editor", "editor")).toBe(true);
    expect(roleAtLeast("admin", "editor")).toBe(true);
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "owner")).toBe(false);
  });

  it("treats no membership as no role", () => {
    expect(roleAtLeast(null, "viewer")).toBe(false);
    expect(roleAtLeast(undefined, "viewer")).toBe(false);
  });
});

describe("personalWorkspaceId", () => {
  it("returns the user's personal workspace", async () => {
    const { client, calls } = fakeClient({ workspaces: [{ data: { id: "ws-1" }, error: null }] });
    expect(await personalWorkspaceId(client, "user-1")).toBe("ws-1");
    expect(calls[0].filters).toEqual([
      ["eq", "created_by", "user-1"],
      ["eq", "is_personal", true],
    ]);
    expect(adminRpc).not.toHaveBeenCalled();
  });

  it("repairs a missing one through the service role", async () => {
    const { client } = fakeClient({ workspaces: [{ data: null, error: null }] });
    adminRpc.mockResolvedValue({ data: "ws-new", error: null });
    expect(await personalWorkspaceId(client, "user-1")).toBe("ws-new");
    expect(adminRpc).toHaveBeenCalledWith("ensure_personal_workspace", { p_user_id: "user-1" });
  });

  it("throws when it cannot be loaded", async () => {
    const { client } = fakeClient({ workspaces: [{ data: null, error: { message: "down" } }] });
    await expect(personalWorkspaceId(client, "user-1")).rejects.toThrow(/down/);
  });
});

describe("loadMemberDocument", () => {
  const doc = { id: "doc-1", workspace_id: "ws-1", user_id: "author", title: "Plan" };

  it("returns the document to a member with the role", async () => {
    const { client, calls } = fakeClient({
      documents: [{ data: doc, error: null }],
      workspace_members: [{ data: { role: "editor" }, error: null }],
    });
    const result = await loadMemberDocument(client, { userId: "u", docId: "doc-1", columns: "title", minRole: "editor" });
    expect(result).toEqual({ ok: true, doc, role: "editor" });
    expect(calls[1].filters).toEqual([
      ["eq", "workspace_id", "ws-1"],
      ["eq", "user_id", "u"],
    ]);
  });

  it("refuses a member below the role", async () => {
    const { client } = fakeClient({
      documents: [{ data: doc, error: null }],
      workspace_members: [{ data: { role: "viewer" }, error: null }],
    });
    expect(await loadMemberDocument(client, { userId: "u", docId: "doc-1", minRole: "editor" })).toEqual({
      ok: false,
      reason: "forbidden",
      role: "viewer",
    });
  });

  it("hides the document from a non-member", async () => {
    const { client } = fakeClient({
      documents: [{ data: doc, error: null }],
      workspace_members: [{ data: null, error: null }],
    });
    expect(await loadMemberDocument(client, { userId: "u", docId: "doc-1", minRole: "viewer" })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("reports a missing document as not found", async () => {
    const { client } = fakeClient({ documents: [{ data: null, error: null }] });
    expect(await loadMemberDocument(client, { userId: "u", docId: "nope", minRole: "viewer" })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("insertWorkspaceDocument", () => {
  it("creates the note in the workspace under a title unique there", async () => {
    const { client, calls } = fakeClient({
      documents: [
        { data: [{ title: "Plan" }], error: null },
        { data: { id: "doc-2" }, error: null },
      ],
    });
    const result = await insertWorkspaceDocument(client, {
      userId: "u",
      workspaceId: "ws-1",
      title: "Plan",
      markdown: (title) => `# ${title}`,
    });
    expect(result).toEqual({ id: "doc-2", title: "Plan 2" });
    expect(calls[0].filters).toEqual([["eq", "workspace_id", "ws-1"]]);
    expect(calls[1].insert).toEqual({ user_id: "u", workspace_id: "ws-1", title: "Plan 2", markdown: "# Plan 2" });
  });

  it("takes the next free title when a teammate took this one first", async () => {
    const { client, calls } = fakeClient({
      documents: [
        { data: [], error: null },
        { data: null, error: { message: "duplicate key", code: "23505" } },
        { data: [{ title: "Plan" }], error: null },
        { data: { id: "doc-3" }, error: null },
      ],
    });
    const result = await insertWorkspaceDocument(client, {
      userId: "u",
      workspaceId: "ws-1",
      title: "Plan",
      markdown: (title) => `# ${title}`,
      extra: { source_template_id: "tpl" },
    });
    expect(result).toEqual({ id: "doc-3", title: "Plan 2" });
    expect(calls[3].insert).toMatchObject({ source_template_id: "tpl", title: "Plan 2" });
  });

  it("gives up on any other error", async () => {
    const { client } = fakeClient({
      documents: [
        { data: [], error: null },
        { data: null, error: { message: "boom", code: "XX000" } },
      ],
    });
    expect(
      await insertWorkspaceDocument(client, { userId: "u", workspaceId: "ws-1", title: "Plan", markdown: () => "" }),
    ).toEqual({ error: "boom" });
  });
});
