import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { chainSyncGate, rlsVisibility, type WorkspaceVisibility } from "@/lib/chain-sync-access";

const ws = "7a000000-0000-4000-8000-0000000000e1";

/** What RLS would let one caller see: workspaces they belong to, jobs they may read. */
function sees(workspace: number | null, jobs: number | null): WorkspaceVisibility & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async workspace(id) {
      asked.push(`workspace:${id}`);
      return workspace;
    },
    async jobs(id) {
      asked.push(`jobs:${id}`);
      return jobs;
    },
  };
}

describe("chainSyncGate", () => {
  it("lets a member run their workspace's queue", async () => {
    expect(await chainSyncGate("u-member", ws, sees(1, 0))).toEqual({ ok: true });
  });

  it("lets a removed member whose removal is still pending run it (D-16)", async () => {
    expect(await chainSyncGate("u-removed", ws, sees(0, 1))).toEqual({ ok: true });
  });

  it("refuses a signed-in non-member with no jobs, as if there were no such workspace", async () => {
    expect(await chainSyncGate("u-stranger", ws, sees(0, 0))).toEqual({ ok: false, status: 404, error: "That isn't a workspace." });
  });

  it("refuses when the database could not answer", async () => {
    expect(await chainSyncGate("u-member", ws, sees(null, null))).toMatchObject({ ok: false, status: 404 });
  });

  it("asks for a session before looking anything up", async () => {
    const v = sees(1, 1);
    expect(await chainSyncGate(null, ws, v)).toMatchObject({ ok: false, status: 401 });
    expect(v.asked).toEqual([]);
  });

  it("refuses an id that is not a workspace id without querying", async () => {
    const v = sees(1, 1);
    expect(await chainSyncGate("u-member", "../jobs", v)).toMatchObject({ ok: false, status: 404 });
    expect(v.asked).toEqual([]);
  });
});

describe("rlsVisibility", () => {
  /** A Supabase client stand-in recording the head-count queries it is given. */
  function client(result: Record<string, { count: number | null; error: unknown }>) {
    const queries: string[] = [];
    const fake = {
      from(table: string) {
        return {
          select(columns: string, options: { count: string; head: boolean }) {
            return {
              async eq(column: string, value: string) {
                queries.push(`${table}.${columns}?${column}=${value}&count=${options.count}&head=${options.head}`);
                return result[table];
              },
            };
          },
        };
      },
    };
    return { queries, supabase: fake as unknown as SupabaseClient };
  }

  it("counts, through the caller's client, the workspace row and the workspace's jobs", async () => {
    const { queries, supabase } = client({
      workspaces: { count: 0, error: null },
      workspace_chain_jobs: { count: 2, error: null },
    });
    const v = rlsVisibility(supabase);
    expect(await v.workspace(ws)).toBe(0);
    expect(await v.jobs(ws)).toBe(2);
    expect(queries).toEqual([
      `workspaces.id?id=${ws}&count=exact&head=true`,
      `workspace_chain_jobs.id?workspace_id=${ws}&count=exact&head=true`,
    ]);
  });

  it("answers null when a query fails, so the gate refuses", async () => {
    const { supabase } = client({
      workspaces: { count: 1, error: { message: "boom" } },
      workspace_chain_jobs: { count: 1, error: { message: "boom" } },
    });
    expect(await chainSyncGate("u-member", ws, rlsVisibility(supabase))).toMatchObject({ ok: false, status: 404 });
  });
});
