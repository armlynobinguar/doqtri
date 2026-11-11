import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/promo/uploads (DOQ-50): with the promo off, a signed-in caller
 * gets a 410 and no upload URL is minted; signed out is still a 401.
 */

const ME = "00000000-0000-4000-8000-000000000003";

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  adminUsed: 0,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
  createSupabaseAdminClient: () => {
    state.adminUsed += 1;
    throw new Error("no storage call is expected here");
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
    new Request("http://localhost/api/promo/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const ONE_SCREENSHOT = { files: [{ type: "image/png", size: 1024 }] };

function setPromoActive(active: boolean) {
  (MINDMAP_PROMO as { active: boolean }).active = active;
}

beforeEach(() => {
  state.user = { id: ME };
  state.adminUsed = 0;
});

describe("with the promo off", () => {
  beforeEach(() => setPromoActive(false));

  it("is a 410 for a signed-in caller, minting nothing", async () => {
    const res = await post(ONE_SCREENSHOT);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "This promo has ended." });
    expect(state.adminUsed).toBe(0);
  });

  it("is still a 401 signed out", async () => {
    state.user = null;
    expect((await post(ONE_SCREENSHOT)).status).toBe(401);
    expect(state.adminUsed).toBe(0);
  });
});

describe("with the promo on", () => {
  beforeEach(() => setPromoActive(true));

  it("goes on to check the request", async () => {
    const res = await post({ files: "not a list" });
    expect(res.status).toBe(400);
    expect(state.adminUsed).toBe(0);
  });
});
