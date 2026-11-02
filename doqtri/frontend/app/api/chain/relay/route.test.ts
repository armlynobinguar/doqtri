import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayRejection as RelayRejectionType } from "@/lib/stellar/relay-validation";

// Only how a refusal becomes a response is under test here: the body parser
// stands in for whatever check or submission step throws.
const refusal = vi.hoisted(() => ({ error: null as RelayRejectionType | null }));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "writer@example.com" } } }) },
  }),
  createSupabaseAdminClient: () => ({}),
}));
vi.mock("@/lib/stellar/relay-validation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stellar/relay-validation")>()),
  parseRelayBody: () => {
    throw refusal.error;
  },
}));

const { RelayRejection } = await import("@/lib/stellar/relay-validation");
const { POST } = await import("./route");

const post = () => POST(new Request("https://doqtri.test/api/chain/relay", { method: "POST", body: "{}" }));

beforeEach(() => {
  refusal.error = null;
});

describe("POST /api/chain/relay refusals", () => {
  it("passes a refusal's Retry-After through to the response (a busy channel pool)", async () => {
    refusal.error = new RelayRejection("Doqtri is busy sending other writes. Try again in a few seconds.", 503, 5);
    const res = await post();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(await res.json()).toEqual({ success: false, error: "Doqtri is busy sending other writes. Try again in a few seconds." });
  });

  it("sends no Retry-After for a refusal that waiting won't fix", async () => {
    refusal.error = new RelayRejection("Invalid auth entries", 400);
    const res = await post();
    expect(res.status).toBe(400);
    expect(res.headers.get("Retry-After")).toBeNull();
  });
});
