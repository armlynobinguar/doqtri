/**
 * Daily on-chain quotas (chain_usage, consume_chain_quota): how many of each
 * kind one user, and everyone together, may spend in 24 hours. The relay and
 * the publish route charge them; /admin/ops (DOQ-14) shows the global use
 * against them. Each can be overridden by its env var; anything that is not
 * a positive integer keeps the default.
 */

export type ChainQuotaKind = "deploy" | "write" | "market" | "publish";

export type ChainQuotaCap = { perUser: number; global: number };

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const CHAIN_QUOTA_CAPS: Readonly<Record<ChainQuotaKind, ChainQuotaCap>> = {
  deploy: {
    perUser: positive(process.env.CHAIN_DEPLOYS_PER_USER_DAILY, 3),
    global: positive(process.env.CHAIN_DEPLOYS_GLOBAL_DAILY, 200),
  },
  write: {
    perUser: positive(process.env.CHAIN_WRITES_PER_USER_DAILY, 100),
    global: positive(process.env.CHAIN_WRITES_GLOBAL_DAILY, 5000),
  },
  market: {
    perUser: positive(process.env.CHAIN_MARKET_PER_USER_DAILY, 50),
    global: positive(process.env.CHAIN_MARKET_GLOBAL_DAILY, 2000),
  },
  publish: {
    perUser: positive(process.env.MARKET_PUBLISH_PER_USER_DAILY, 10),
    global: positive(process.env.MARKET_PUBLISH_GLOBAL_DAILY, 500),
  },
};
