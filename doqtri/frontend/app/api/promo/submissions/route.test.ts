import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/promo/submissions (DOQ-50): with the promo off, a signed-in caller
 * gets a 410 and nothing is read, written, counted or rated; signed out is
 * still a 401.
 */

const ME = "00000000-0000-4000-8000-000000000003";
const UPLOAD = "11111111-1111-4111-8111-111111111111";

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  touched: [] as string[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: (table: string) => {
      state.touched.push(`session:${table}`);
      throw new Error("no query is expected here");
    },
  }),
  createSupabaseAdminClient: () => {
    state.touched.push("admin");
    throw new Error("no service-role call is expected here");
  },
}));
vi.mock("@/lib/ai-quota", () => ({
  consumeAiQuota: async () => {
    state.touched.push("quota");
    throw new Error("no quota is expected to be spent");
  },
}));
vi.mock("@/lib/promo-rating-ai", () => ({
  rateAndStoreSubmission: async () => {
    state.touched.push("rating");
  },
}));
// A copy of the promo's config, so the flag can be set whatever lib/promo.ts says.
vi.mock("@/lib/promo", async (original) => {
  const actual = await original<typeof import("@/lib/promo")>();
  return { ...actual, MINDMAP_PROMO: { ...actual.MINDMAP_PROMO } };
});

const { MINDMAP_PROMO } = await import("@/lib/promo");
const { POST } = await import("./route");

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/promo/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const ENTRY = {
  uploadId: UPLOAD,
  paths: [`${ME}/${UPLOAD}/0.png`],
  caption: "My first Web3 note",
  contact: "@someone",
};

function setPromoActive(active: boolean) {
  (MINDMAP_PROMO as { active: boolean }).active = active;
}

beforeEach(() => {
  state.user = { id: ME };
  state.touched = [];
});

describe("with the promo off", () => {
  beforeEach(() => setPromoActive(false));

  it("is a 410 for a signed-in caller, touching nothing", async () => {
    const res = await post(ENTRY);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "This promo has ended." });
    expect(state.touched).toEqual([]);
  });

  it("is still a 401 signed out", async () => {
    state.user = null;
    expect((await post(ENTRY)).status).toBe(401);
    expect(state.touched).toEqual([]);
  });
});

describe("with the promo on", () => {
  beforeEach(() => setPromoActive(true));

  it("goes on to check the request", async () => {
    const res = await post("not json");
    expect(res.status).toBe(400);
    expect(state.touched).toEqual([]);
  });
});
