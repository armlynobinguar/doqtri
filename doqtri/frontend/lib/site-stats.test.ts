import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchInvocations, loadSiteStats, statsContracts } from "./site-stats";

function fakeAdmin(users: number, documents: number) {
  return {
    auth: { admin: { listUsers: async () => ({ data: { users: [], total: users }, error: null }) } },
    from: () => ({ select: () => Promise.resolve({ count: documents, error: null }) }),
  } as unknown as SupabaseClient;
}

const expert = (byId: Record<string, number | "fail">) =>
  (async (url: string) => {
    const id = String(url).split("/").pop()!;
    const n = byId[id];
    if (n === undefined || n === "fail") return new Response("nope", { status: 500 });
    return Response.json({ contract: id, invocations: n });
  }) as unknown as typeof fetch;

describe("site stats", () => {
  it("sums invocations across every Doqtri contract", async () => {
    const ids = statsContracts().map((c) => c.id);
    const counts = Object.fromEntries(ids.map((id, i) => [id, (i + 1) * 100]));
    const stats = await loadSiteStats(fakeAdmin(42, 99), expert(counts));
    expect(stats.users).toBe(42);
    expect(stats.documents).toBe(99);
    expect(stats.transactions).toBe(ids.reduce((s, _, i) => s + (i + 1) * 100, 0));
    expect(stats.contracts[0].url).toContain(`/contract/${ids[0]}`);
  });

  it("counts an unreadable contract as zero but fails when none can be read", async () => {
    const [first, ...rest] = statsContracts().map((c) => c.id);
    const partial = await loadSiteStats(fakeAdmin(1, 1), expert({ [first]: 7, ...Object.fromEntries(rest.map((id) => [id, "fail"])) }));
    expect(partial.transactions).toBe(7);
    await expect(loadSiteStats(fakeAdmin(1, 1), expert({}))).rejects.toThrow(/stellar\.expert/);
  });

  it("returns null when the response has no invocation count", async () => {
    const f = (async () => Response.json({ contract: "x" })) as unknown as typeof fetch;
    expect(await fetchInvocations("x", f)).toBeNull();
  });
});
