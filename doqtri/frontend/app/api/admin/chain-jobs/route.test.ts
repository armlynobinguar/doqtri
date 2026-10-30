import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  counts: { pending: 3, needs_product_owner: 1, failed: 0 } as Record<string, number>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
  createSupabaseAdminClient: () => ({
    from: () => {
      let status = "";
      const query = {
        select: () => query,
        eq: (_column: string, value: string) => {
          status = value;
          return Object.assign(Promise.resolve({ count: state.counts[status] ?? 0, error: null }), query);
        },
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({ data: { created_at: "2026-10-25T00:00:00Z" } }),
      };
      return query;
    },
  }),
}));
vi.mock("@/lib/stellar/config", () => ({ REGISTRY_EDITORS: true }));
vi.mock("@/lib/stellar/chain-jobs-scheduler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stellar/chain-jobs-scheduler")>()),
  readSchedulerHealth: async () => ({ status: "unavailable", job: false, missingSecrets: [] }),
}));

const { GET } = await import("./route");

beforeEach(() => {
  vi.stubEnv("DOQTRI_ADMINS", "staff@doqtri.test");
  state.user = { id: "u-staff", email: "staff@doqtri.test" };
});

describe("GET /api/admin/chain-jobs", () => {
  it("shows staff the scheduler's health and the open jobs by status", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      registryEditors: true,
      scheduler: { status: "unavailable" },
      jobs: { pending: 3, needs_product_owner: 1, failed: 0 },
      oldestPendingAt: "2026-10-25T00:00:00Z",
    });
    expect(body.warning).toMatch(/no pg_cron/);
  });

  it("answers 404 to anyone else", async () => {
    state.user = { id: "u-member", email: "member@doqtri.test" };
    expect((await GET()).status).toBe(404);
    state.user = null;
    expect((await GET()).status).toBe(404);
  });
});
