import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseSchedulerHealth, readSchedulerHealth, schedulerWarning } from "./chain-jobs-scheduler";

const client = (rpc: () => Promise<unknown>) => ({ rpc }) as unknown as SupabaseClient;

describe("parseSchedulerHealth", () => {
  it("reads the database's answer", () => {
    expect(parseSchedulerHealth({ status: "configured", job: true, missing_secrets: [] })).toEqual({
      status: "configured",
      job: true,
      missingSecrets: [],
    });
    expect(
      parseSchedulerHealth({ status: "missing", job: true, missing_secrets: ["doqtri_cron_secret"] }),
    ).toEqual({ status: "missing", job: true, missingSecrets: ["doqtri_cron_secret"] });
  });

  it("claims nothing for an answer it does not recognise", () => {
    for (const value of [null, "configured", { status: "fine", job: true, missing_secrets: [] }, { status: "missing" }]) {
      expect(parseSchedulerHealth(value).status).toBe("unknown");
    }
  });
});

describe("schedulerWarning", () => {
  it("says nothing when the job can run", () => {
    expect(schedulerWarning({ status: "configured", job: true, missingSecrets: [] })).toBeNull();
  });

  it("names the missing secrets, never anything else", () => {
    const line = schedulerWarning({ status: "missing", job: true, missingSecrets: ["doqtri_chain_jobs_url", "doqtri_cron_secret"] });
    expect(line).toMatch(/until Vault holds doqtri_chain_jobs_url, doqtri_cron_secret/);
    expect(line).toMatch(/daily Vercel cron/);
  });

  it("warns for an inactive job, a database without the extensions, and a failed check", () => {
    expect(schedulerWarning({ status: "missing", job: false, missingSecrets: [] })).toMatch(/missing or inactive/);
    expect(schedulerWarning({ status: "unavailable", job: false, missingSecrets: [] })).toMatch(/no pg_cron/);
    expect(schedulerWarning({ status: "unknown", job: null, missingSecrets: [] })).toMatch(/could not read/);
  });
});

describe("readSchedulerHealth", () => {
  it("asks chain_jobs_scheduler_health()", async () => {
    const rpc = vi.fn(async () => ({ data: { status: "configured", job: true, missing_secrets: [] }, error: null }));
    expect(await readSchedulerHealth(client(rpc))).toMatchObject({ status: "configured" });
    expect(rpc).toHaveBeenCalledWith("chain_jobs_scheduler_health");
  });

  it("never throws: an error or a rejection is unknown", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readSchedulerHealth(client(async () => ({ data: null, error: { message: "no such function" } })))).toMatchObject({
      status: "unknown",
    });
    expect(
      await readSchedulerHealth(
        client(async () => {
          throw new Error("offline");
        }),
      ),
    ).toMatchObject({ status: "unknown" });
    spy.mockRestore();
  });
});
