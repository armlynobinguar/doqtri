import { beforeEach, describe, expect, it, vi } from "vitest";

const health = vi.hoisted(() => ({ value: { status: "configured", job: true, missingSecrets: [] as string[] } }));

vi.mock("@/lib/supabase/server", () => ({ createSupabaseAdminClient: () => ({}) }));
const runChainJobs = vi.fn();
vi.mock("@/lib/stellar/chain-jobs", () => ({ runChainJobs: (...args: unknown[]) => runChainJobs(...args) }));
const runPendingWrites = vi.fn();
vi.mock("@/lib/stellar/pending-writes", () => ({ runPendingWrites: (...args: unknown[]) => runPendingWrites(...args) }));
const runWalletTopUps = vi.fn();
vi.mock("@/lib/stellar/wallet-topups", () => ({ runWalletTopUps: (...args: unknown[]) => runWalletTopUps(...args) }));
const runReferralSync = vi.fn();
vi.mock("@/lib/referral-activity", () => ({ runReferralSync: (...args: unknown[]) => runReferralSync(...args) }));
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
  runPendingWrites.mockReset();
  runPendingWrites.mockResolvedValue({ confirmed: 1, failed: 0, pending: 2 });
  runWalletTopUps.mockReset();
  runWalletTopUps.mockResolvedValue({ skipped: false, done: 1, pending: 0, failed: 0 });
  runReferralSync.mockReset();
  runReferralSync.mockResolvedValue({ synced: 3, failed: 0, skipped: 0 });
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
      pendingWrites: { confirmed: 1, failed: 0, pending: 2 },
      topUps: { skipped: false, done: 1, pending: 0, failed: 0 },
      referrals: { synced: 3, failed: 0, skipped: 0 },
      scheduler: { status: "configured", job: true, missingSecrets: [] },
    });
    expect(runChainJobs).toHaveBeenCalledWith(expect.anything(), { limit: 50 });
    expect(runPendingWrites).toHaveBeenCalledTimes(1);
    expect(runWalletTopUps).toHaveBeenCalledTimes(1);
    expect(runReferralSync).toHaveBeenCalledTimes(1);
  });

  it("settles pending paid writes even when the queue fails, and works the queue when they can't be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    runChainJobs.mockRejectedValueOnce(new Error("claim failed"));
    const failedQueue = await run("Bearer s3cret");
    expect(failedQueue.status).toBe(503);
    expect((await failedQueue.json()).pendingWrites).toEqual({ confirmed: 1, failed: 0, pending: 2 });

    runPendingWrites.mockRejectedValueOnce(new Error("RPC down"));
    const res = await run("Bearer s3cret");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ done: 2, pendingWrites: null });
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/pending writes not settled: RPC down/));
    error.mockRestore();
  });

  it("works the queue alongside settling pending writes, not after it", async () => {
    let settle: (summary: unknown) => void = () => {};
    runPendingWrites.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
    const response = run("Bearer s3cret");
    await vi.waitFor(() => expect(runChainJobs).toHaveBeenCalledTimes(1));
    settle({ confirmed: 0, failed: 0, pending: 0 });
    expect((await (await response).json()).pendingWrites).toEqual({ confirmed: 0, failed: 0, pending: 0 });
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

  it("a failing referral sync stops nothing else, and the sync runs when the others fail (DOQ-23)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    runReferralSync.mockRejectedValueOnce(new Error("Horizon down"));
    const failedSync = await run("Bearer s3cret");
    expect(failedSync.status).toBe(200);
    expect(await failedSync.json()).toMatchObject({
      done: 2,
      pendingWrites: { confirmed: 1, failed: 0, pending: 2 },
      topUps: { skipped: false, done: 1, pending: 0, failed: 0 },
      referrals: null,
    });
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/referral sync failed: .*Horizon down/));

    runChainJobs.mockRejectedValueOnce(new Error("db down"));
    runPendingWrites.mockRejectedValueOnce(new Error("RPC down"));
    runWalletTopUps.mockRejectedValueOnce(new Error("rpc down"));
    const othersFailed = await run("Bearer s3cret");
    expect(othersFailed.status).toBe(503);
    expect(await othersFailed.json()).toMatchObject({
      pendingWrites: null,
      topUps: null,
      referrals: { synced: 3, failed: 0, skipped: 0 },
    });
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
    expect(runPendingWrites).not.toHaveBeenCalled();
    expect(runWalletTopUps).not.toHaveBeenCalled();
    expect(runReferralSync).not.toHaveBeenCalled();
  });
});
