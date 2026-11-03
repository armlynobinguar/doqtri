import { logError } from "@/lib/log-error";
import { lowIsBad, type Limits } from "@/lib/ops/levels";
import type { OpsDeps } from "@/lib/ops/deps";
import { CHECK_TIMEOUT_MS, withTimeout } from "@/lib/ops/run-check";
import type { OpsChannel, OpsChannels } from "@/lib/ops/types";
import { TESTNET_REFILL_BELOW_XLM } from "@/lib/stellar/channel-accounts.mjs";
import { relayPoolEnabled } from "@/lib/stellar/channel-pool";
import { expertAccountUrl } from "@/lib/stellar/config";

/**
 * Relayer and channel accounts pay every paid write's fee. On testnet the
 * relayer refills itself from Friendbot below 1,000 XLM (direct-submit.ts),
 * and the seed script refills channels below the same floor, so crit is that
 * floor and warn is twice it. Mainnet writes cost well under 1 XLM each.
 */
export const FEE_PAYER_LIMITS: Readonly<Record<"testnet" | "mainnet", Limits>> = {
  testnet: { warn: 2 * TESTNET_REFILL_BELOW_XLM, crit: TESTNET_REFILL_BELOW_XLM },
  mainnet: { warn: 50, crit: 10 },
};

/**
 * Every relay channel on this network with its balance (DOQ-15). The
 * "Relay channel XLM" check and the per-channel table both read this; in a
 * report the channel list and each balance are read once (collect.ts shares
 * them). A balance that cannot be read is unknown on its own row only.
 */
export async function readChannelRows(deps: OpsDeps): Promise<OpsChannel[]> {
  const channels = await deps.channels();
  const limits = FEE_PAYER_LIMITS[deps.config.network];
  const balances = await Promise.allSettled(channels.map((c) => deps.balance(c.publicKey)));
  const now = deps.now();
  return channels.map((channel, i) => {
    const read = balances[i];
    const leased = channel.leasedUntil !== null && Date.parse(channel.leasedUntil) > now;
    const base = {
      idx: channel.idx,
      publicKey: channel.publicKey,
      explorerUrl: expertAccountUrl(channel.publicKey),
      leasedUntil: leased ? channel.leasedUntil : null,
    };
    if (read.status === "rejected") return { ...base, xlm: null, status: "unknown" };
    if (!read.value.funded) return { ...base, xlm: null, status: "crit" };
    return { ...base, xlm: read.value.spendable, status: lowIsBad(read.value.spendable, limits) };
  });
}

/** The per-channel table, or why it could not be read. Never throws. */
export async function channelSection(deps: OpsDeps, timeoutMs = CHECK_TIMEOUT_MS): Promise<OpsChannels> {
  try {
    const rows = await withTimeout(readChannelRows(deps), timeoutMs);
    return { ok: true, poolOn: relayPoolEnabled(), limits: FEE_PAYER_LIMITS[deps.config.network], rows };
  } catch (error) {
    logError("[admin/ops] channel table", error);
    return { ok: false, error: `Could not read the relay channels within ${timeoutMs / 1000} s; see the server log` };
  }
}
