import { NextRequest } from "next/server";
import { getRedirectUrl, getRewrittenUrl, isRewrite } from "next/experimental/testing/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * proxy.ts and the promo portal (DOQ-50): once the promo ends, /promo is
 * rewritten to a path no route matches, so everyone gets a real 404 status
 * rather than a 200 streamed behind the root loading.tsx.
 */

const state = vi.hoisted(() => ({ user: null as { id: string } | null }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}));
// A copy of the promo's config, so the flag can be set whatever lib/promo.ts says.
vi.mock("@/lib/promo", async (original) => {
  const actual = await original<typeof import("@/lib/promo")>();
  return { ...actual, MINDMAP_PROMO: { ...actual.MINDMAP_PROMO } };
});

const { MINDMAP_PROMO } = await import("@/lib/promo");
const { ENDED_PROMO_REWRITE, proxy } = await import("./proxy");

const ORIGIN = "https://doqtri.test";
const visit = (path: string) => proxy(new NextRequest(`${ORIGIN}${path}`));

function setPromoActive(active: boolean) {
  (MINDMAP_PROMO as { active: boolean }).active = active;
}

const VISITORS: [string, { id: string } | null][] = [
  ["signed out", null],
  ["signed in", { id: "00000000-0000-4000-8000-000000000003" }],
];

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
});

describe.each(VISITORS)("a visitor %s at /promo", (_label, user) => {
  beforeEach(() => {
    state.user = user;
  });

  it("is rewritten to a path no route matches while the promo is off", async () => {
    setPromoActive(false);
    const res = await visit("/promo");
    expect(isRewrite(res)).toBe(true);
    expect(getRewrittenUrl(res)).toBe(`${ORIGIN}${ENDED_PROMO_REWRITE}`);
  });

  it("reaches the portal while the promo is on", async () => {
    setPromoActive(true);
    const res = await visit("/promo");
    expect(isRewrite(res)).toBe(false);
    expect(getRedirectUrl(res)).toBeNull();
  });
});

describe("the rewrite target", () => {
  it("is a private (underscore) path, which the app router never routes", () => {
    expect(ENDED_PROMO_REWRITE).toMatch(/^\/_[a-z-]+$/);
  });
});
