import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  collected: 0,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
  createSupabaseAdminClient: () => ({}),
}));
vi.mock("@/lib/ops/deps", () => ({ liveOpsDeps: () => ({}) }));
vi.mock("@/lib/ops/collect", () => ({
  collectOps: async () => {
    state.collected += 1;
    return {
      generatedAt: "2026-11-03T12:00:00.000Z",
      environment: "test",
      network: "testnet",
      commit: null,
      checks: [{ id: "relayer-balance", section: "spendable", label: "Relayer XLM", status: "ok", value: "9,000 XLM" }],
    };
  },
}));

const { GET } = await import("./route");

beforeEach(() => {
  vi.stubEnv("DOQTRI_ADMINS", "staff@doqtri.test");
  state.user = { id: "u-staff", email: "staff@doqtri.test" };
  state.collected = 0;
});

describe("GET /api/admin/ops", () => {
  it("gives staff the report, uncached", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ network: "testnet", checks: [{ id: "relayer-balance", status: "ok" }] });
  });

  it("answers 404 to anyone else, and runs no checks for them", async () => {
    state.user = { id: "u-member", email: "member@doqtri.test" };
    expect((await GET()).status).toBe(404);
    state.user = null;
    expect((await GET()).status).toBe(404);
    expect(state.collected).toBe(0);
  });
});
