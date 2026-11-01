import { beforeEach, describe, expect, it, vi } from "vitest";

const health = vi.hoisted(() => ({ value: { status: "configured", job: true, missingSecrets: [] as string[] } }));

vi.mock("@/lib/supabase/server", () => ({ createSupabaseAdminClient: () => ({}) }));
const runChainJobs = vi.fn();
vi.mock("@/lib/stellar/chain-jobs", () => ({ runChainJobs: (...args: unknown[]) => runChainJobs(...args) }));
const runWalletTopUps = vi.fn();
vi.mock("@/lib/stellar/wallet-topups", () => ({ runWalletTopUps: (...args: unknown[]) => runWalletTopUps(...args) }));
vi.mock("@/lib/stellar/chain-jobs-scheduler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stellar/chain-jobs-scheduler")>()),
  readSchedulerHealth: async () => health.value,
}));

const { GET } = await import("./route");

const run = (authorization?: string) =>
  GET(new Request("https://doqtri.test/api/chain/jobs", { headers: authorization ? { authorization } : {} }));

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "s3cret");
  health.value = { status: "configured", job: true, missingSecrets: [] };
  runChainJobs.mockReset();
  runChainJobs.mockResolvedValue({ done: 2, pending: 0, failed: 0, needsProductOwner: 0 });
  runWalletTopUps.mockReset();
  runWalletTopUps.mockResolvedValue({ skipped: false, done: 1, pending: 0, failed: 0 });
});

describe("GET /api/chain/jobs", () => {
  it("runs the queue for the scheduler's bearer, and says whether the pg_cron job can run", async () => {
    const res = await run("Bearer s3cret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      done: 2,
      pending: 0,
      failed: 0,
      needsProductOwner: 0,
      topUps: { skipped: false, done: 1, pending: 0, failed: 0 },
      scheduler: { status: "configured", job: true, missingSecrets: [] },
    });
    expect(runChainJobs).toHaveBeenCalledWith(expect.anything(), { limit: 50 });
    expect(runWalletTopUps).toHaveBeenCalledTimes(1);
  });

  it("retries wallet top-ups even when the chain jobs fail, and the other way round (DOQ-6)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    runChainJobs.mockRejectedValueOnce(new Error("db down"));
    const failedJobs = await run("Bearer s3cret");
    expect(failedJobs.status).toBe(503);
    expect((await failedJobs.json()).topUps).toEqual({ skipped: false, done: 1, pending: 0, failed: 0 });

    runWalletTopUps.mockRejectedValueOnce(new Error("rpc down"));
    const failedTopUps = await run("Bearer s3cret");
    expect(failedTopUps.status).toBe(200);
    expect(await failedTopUps.json()).toMatchObject({ done: 2, topUps: null });
    error.mockRestore();
  });

  it("logs a warning when the pg_cron job cannot run, and still works the queue", async () => {
    health.value = { status: "missing", job: true, missingSecrets: ["doqtri_cron_secret"] };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await run("Bearer s3cret");
    expect((await res.json()).scheduler.status).toBe("missing");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/until Vault holds doqtri_cron_secret/));
    expect(runChainJobs).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("refuses without the bearer, or with CRON_SECRET unset", async () => {
    expect((await run()).status).toBe(401);
    expect((await run("Bearer wrong")).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await run("Bearer ")).status).toBe(401);
    expect(runChainJobs).not.toHaveBeenCalled();
    expect(runWalletTopUps).not.toHaveBeenCalled();
  });
});
