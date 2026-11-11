import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * GET /api/integrations/qdit/hackathons (WP-4.7, D-122): the flag, sign-in
 * and configuration checks, the list as the dialog reads it, and the 200
 * fallback when qdit has no list endpoint yet (QDIT-60). qdit is a fake
 * QditClient; listHackathons() is tested on its own against a stubbed fetch
 * (qdit-client.test.ts).
 */

const ME = "00000000-0000-4000-8000-000000000003";

let user: { id: string } | null = { id: ME };
let configured = true;
let sessionReads = 0;

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => {
    sessionReads += 1;
    return { auth: { getUser: async () => ({ data: { user } }) } };
  },
  createSupabaseAdminClient: () => ({}),
}));

const qdit = { listHackathons: vi.fn() };
const clientFor = vi.fn<(...args: unknown[]) => typeof qdit>(() => qdit);
vi.mock("@/lib/integrations/qdit-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/qdit-client")>()),
  qditServerSetup: () => (configured ? { config: {}, tokenKey: Buffer.alloc(32), store: {} } : null),
  createQditClient: (...args: unknown[]) => clientFor(...args),
}));

const { QditError, QditNotConnectedError } = await import("@/lib/integrations/qdit-client");
const { GET } = await import("./route");

const OPEN = {
  slug: "stellar-build-2026",
  name: "Stellar Build 2026",
  opens_at: "2026-11-10T01:00:00.000Z",
  closes_at: "2026-11-21T09:00:00.000Z",
  state: "open" as const,
};
const UPCOMING = { ...OPEN, slug: "soroban-sprint", name: "Soroban Sprint", opens_at: "2026-11-14T01:00:00.000Z", state: "upcoming" as const };

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "1");
  vi.stubEnv("NEXT_PUBLIC_QDIT_HACKATHON", "1");
  user = { id: ME };
  configured = true;
  sessionReads = 0;
  clientFor.mockClear();
  qdit.listHackathons.mockReset();
  qdit.listHackathons.mockResolvedValue([OPEN, UPCOMING]);
});

describe("the flag", () => {
  it.each([
    ["the hackathon flag off", "1", ""],
    ["the integration off", "", "1"],
  ])("is 404 with %s, before reading anything", async (_name, integration, hackathon) => {
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", integration);
    vi.stubEnv("NEXT_PUBLIC_QDIT_HACKATHON", hackathon);
    const res = await GET();
    expect(res.status).toBe(404);
    expect(sessionReads).toBe(0);
    expect(qdit.listHackathons).not.toHaveBeenCalled();
  });
});

describe("before asking qdit", () => {
  it("needs a signed-in user", async () => {
    user = null;
    const res = await GET();
    expect(res.status).toBe(401);
    expect(qdit.listHackathons).not.toHaveBeenCalled();
  });

  it("says so when qdit isn't set up on this deployment", async () => {
    configured = false;
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("QDIT_NOT_CONFIGURED");
    expect(qdit.listHackathons).not.toHaveBeenCalled();
  });
});

describe("the list", () => {
  it("answers qdit's hackathons in qdit's order, as the user, not cached", async () => {
    qdit.listHackathons.mockResolvedValue([{ ...OPEN, extra: "kept out" }, UPCOMING]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ hackathons: [OPEN, UPCOMING] });
    expect(clientFor).toHaveBeenCalledWith(ME, expect.anything());
  });

  it("answers an empty list as is", async () => {
    qdit.listHackathons.mockResolvedValue([]);
    expect(await (await GET()).json()).toEqual({ hackathons: [] });
  });

  it("falls back to the link field when qdit has no list endpoint (404)", async () => {
    qdit.listHackathons.mockRejectedValue(new QditError("not_found", "Not found", { status: 404, code: "not_found" }));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ hackathons: null, list_unavailable: true });
  });

  it.each([
    ["no connection", new QditNotConnectedError("none"), 409, "QDIT_NOT_CONNECTED"],
    ["qdit down", new QditError("unavailable", "down", { status: 503 }), 502, "QDIT_UNAVAILABLE"],
    ["a rate limit", new QditError("rate_limited", "slow", { status: 429, retryAfterSeconds: 7 }), 429, "QDIT_RATE_LIMITED"],
    ["an unreadable list", new QditError("bad_response", "bad"), 502, "QDIT_UNAVAILABLE"],
  ])("reports %s as an error, not as a missing list", async (_name, error, status, code) => {
    qdit.listHackathons.mockRejectedValue(error);
    const res = await GET();
    expect(res.status).toBe(status);
    const json = await res.json();
    expect(json.code).toBe(code);
    expect(json).not.toHaveProperty("list_unavailable");
    if (code === "QDIT_RATE_LIMITED") expect(res.headers.get("retry-after")).toBe("7");
  });
});
