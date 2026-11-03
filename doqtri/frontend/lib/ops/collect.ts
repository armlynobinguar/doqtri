import { channelSection } from "@/lib/ops/channels";
import type { OpsDeps } from "@/lib/ops/deps";
import { healthChecks } from "@/lib/ops/health";
import { once, onceEach, runChecks } from "@/lib/ops/run-check";
import { spendableChecks } from "@/lib/ops/spendable";
import { statusChecks } from "@/lib/ops/statuses";
import type { OpsCheckDef, OpsReport } from "@/lib/ops/types";

export function opsCheckDefs(deps: OpsDeps): OpsCheckDef[] {
  return [...spendableChecks(deps), ...statusChecks(deps), ...healthChecks(deps)];
}

/**
 * One run of every check (DOQ-14): the /admin/ops report. Never throws; a
 * check that fails reads as unknown. Holds public keys, counts and presence
 * only, so it is safe to send to an admin's browser.
 */
export async function collectOps(deps: OpsDeps, timeoutMs?: number): Promise<OpsReport> {
  // One read per report of the channel list and each balance, shared by the
  // checks and the per-channel table.
  const shared: OpsDeps = { ...deps, channels: once(deps.channels), balance: onceEach(deps.balance) };
  const [checks, channels] = await Promise.all([
    runChecks(opsCheckDefs(shared), timeoutMs),
    channelSection(shared, timeoutMs),
  ]);
  return {
    generatedAt: new Date(deps.now()).toISOString(),
    environment: process.env.VERCEL_ENV?.trim() || process.env.NODE_ENV || "unknown",
    network: deps.config.network,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.trim().slice(0, 8) || null,
    checks,
    channels,
  };
}
