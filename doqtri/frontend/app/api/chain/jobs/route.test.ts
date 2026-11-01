import { beforeEach, describe, expect, it, vi } from "vitest";

const health = vi.hoisted(() => ({ value: { status: "configured", job: true, missingSecrets: [] as string[] } }));

vi.mock("@/lib/supabase/server", () => ({ createSupabaseAdminClient: () => ({}) }));
const runChainJobs = vi.fn();
vi.mock("@/lib/stellar/chain-jobs", () => ({ runChainJobs: (...args: unknown[]) => runChainJobs(...args) }));
const runPendingWrites = vi.fn();
vi.mock("@/lib/stellar/pending-writes", () => ({ runPendingWrites: (...args: unknown[]) => runPendingWrites(...args) }));
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
      scheduler: { status: "configured", job: true, missingSecrets: [] },
    });
    expect(runChainJobs).toHaveBeenCalledWith(expect.anything(), { limit: 50 });
    expect(runPendingWrites).toHaveBeenCalledTimes(1);
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
  });
});
