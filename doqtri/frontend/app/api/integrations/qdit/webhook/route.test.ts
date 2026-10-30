import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The webhook route (WP-2.8): off without the flag, waiting without its
 * secret, and otherwise handing the raw bytes and headers to
 * handleQditWebhook (tested in lib/integrations/qdit-status-sync.test.ts).
 */

const SECRET = "whsec_example_do_not_use";
const TIMESTAMP = "1792843200";
const BODY =
  '{"id":"7d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10","event":"milestone.status_changed","project_id":"3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34","milestone_id":"b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61","status":"approved","occurred_at":"2026-10-24T11:59:58.412Z"}';
const SIGNATURE = "sha256=2af3710d7ffbe0732e23e5d7e81b6e3350569bb189fd133681af78a2826e1bfe";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseAdminClient: () => ({}) }));

const recorded: unknown[] = [];
vi.mock("@/lib/integrations/qdit-status-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/qdit-status-sync")>()),
  supabaseStatusStore: () => ({
    linkedMilestone: async () => ({
      linked: true,
      chain: { network: "testnet", contractId: "CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG" },
    }),
    claimEvent: async () => "new",
    record: async (input: unknown) => {
      recorded.push(input);
      return "recorded";
    },
  }),
  readChainOverRpc: async () => ({
    ledger: 900,
    record: { status: "Approved", version: 2, proofHash: "ab".repeat(32), submitter: "G", timestamp: 1 },
  }),
}));

const { POST } = await import("./route");

const post = (body = BODY, headers: Record<string, string> = { "X-Qdit-Timestamp": TIMESTAMP, "X-Qdit-Signature": SIGNATURE }) =>
  POST(
    new Request("http://localhost/api/integrations/qdit/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
      body,
    }),
  );

beforeEach(() => {
  recorded.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(Number(TIMESTAMP) * 1000 + 2_000);
  vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "1");
  vi.stubEnv("QDIT_WEBHOOK_SECRET", SECRET);
  return () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  };
});

describe("POST /api/integrations/qdit/webhook", () => {
  it("is not there with the integration off", async () => {
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "");
    expect((await post()).status).toBe(404);
  });

  it("asks qdit to retry later while its secret is missing", async () => {
    vi.stubEnv("QDIT_WEBHOOK_SECRET", "");
    expect((await post()).status).toBe(503);
  });

  it("accepts the contract's worked example and records the chain's answer", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
    expect(recorded).toEqual([
      expect.objectContaining({
        milestoneId: "b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61",
        chain: expect.objectContaining({ status: "Approved", version: 2 }),
        eventId: "7d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10",
      }),
    ]);
  });

  it("signs over the raw bytes: the same JSON re-spaced does not verify", async () => {
    expect((await post(BODY.replace('","', '", "'))).status).toBe(401);
  });

  it("refuses a stale delivery", async () => {
    vi.setSystemTime(Number(TIMESTAMP) * 1000 + 301_000);
    expect((await post()).status).toBe(401);
    expect(recorded).toEqual([]);
  });

  it("refuses a body declared over 64 KiB without reading it", async () => {
    const res = await POST(
      new Request("http://localhost/x", { method: "POST", headers: { "Content-Length": "70000" }, body: "{}" }),
    );
    expect(res.status).toBe(413);
  });
});
