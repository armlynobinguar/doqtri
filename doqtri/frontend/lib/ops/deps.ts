import type { SupabaseClient } from "@supabase/supabase-js";
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { getAccountBalance, type AccountBalance } from "@/lib/stellar/horizon";
import {
  CONTRACT_ID,
  HORIZON_URL,
  MARKET_CONTRACT_ID,
  REGISTRY_EDITORS,
  RPC_URL,
  expertApiContractUrl,
} from "@/lib/stellar/config";
import { DOQTRI_RELAYER, FEE_FORWARDER, NETWORK, type StellarNetwork } from "@/lib/stellar/smart-wallet-config";
import { CHECK_TIMEOUT_MS, memoize, once } from "@/lib/ops/run-check";

/**
 * What ops_snapshot() answers (doqtri/backend/migrations/20261103100000_ops_snapshot.sql).
 * Counts, ages and sizes only.
 */
export type OpsSnapshot = {
  at: string;
  chain_jobs: { pending: number; needs_product_owner: number; failed: number; failed_24h: number; oldest_pending_at: string | null };
  wallet_topups: { pending: number; failed: number; failed_24h: number; oldest_pending_at: string | null };
  chain_writes: { pending: number; oldest_pending_at: string | null; failed_24h: number };
  relay_channels: { network: string; total: number; leased: number }[];
  chain_usage_24h: { network: string; kind: string; count: number }[];
  ai_usage_24h: { total: number; by_route: Record<string, number>; top_user: number };
  ingests: { total_24h: number; failed_24h: number; stuck_pending: number };
  qdit: { connections: Record<string, number>; webhooks_late: number };
  moderation: { templates_pending: number; reports_open: number; promo_pending: number; promo_rating_errors: number };
  doc_locks: { active: number; stale: number };
  storage: { db_bytes: number; buckets: Record<string, number> | null };
  scheduler: unknown;
  cron: {
    last_run: { status: string; start_time: string | null; end_time: string | null; message: string | null } | null;
    last_http: { status_code: number | null; timed_out: boolean | null; error: string | null; created: string | null } | null;
  };
};

/** A contract's instance and code entries: the ledger each lives until, and the latest ledger. */
export type ContractTtl = { latestLedger: number; instanceLiveUntil: number | null; codeLiveUntil: number | null };

/** The deployment's public settings the checks read. No secrets. */
export type OpsConfig = {
  network: StellarNetwork;
  relayer: string | null;
  registry: string;
  market: string | null;
  feeForwarder: string | null;
  horizonUrl: string;
  registryEditors: boolean;
  /** Whether the server uses SOROBAN_RPC_URL rather than the public default. Never the URL. */
  dedicatedRpc: boolean;
  expertApiUrl: string;
};

/** Everything the checks reach outside themselves, so tests can stand it in. */
export type OpsDeps = {
  now: () => number;
  config: OpsConfig;
  snapshot: () => Promise<OpsSnapshot>;
  channelKeys: () => Promise<string[]>;
  balance: (address: string) => Promise<AccountBalance>;
  contractTtl: (contractId: string) => Promise<ContractTtl | null>;
  rpcHealth: () => Promise<{ status: string; latestLedger: number }>;
  fetch: typeof fetch;
};

function instanceKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/** Reads the instance entry, then the wasm it runs; null when the contract is not on this network. */
export async function readContractTtl(server: rpc.Server, contractId: string): Promise<ContractTtl | null> {
  const found = await server.getLedgerEntries(instanceKey(contractId));
  const entry = found.entries[0];
  if (!entry) return null;
  const executable = entry.val.contractData().val().instance().executable();
  let codeLiveUntil: number | null = null;
  if (executable.switch().value === xdr.ContractExecutableType.contractExecutableWasm().value) {
    const code = await server.getLedgerEntries(
      xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: executable.wasmHash() })),
    );
    codeLiveUntil = code.entries[0]?.liveUntilLedgerSeq ?? null;
  }
  return {
    latestLedger: found.latestLedger,
    instanceLiveUntil: entry.liveUntilLedgerSeq ?? null,
    codeLiveUntil,
  };
}

/** Balances move by fractions of a lumen per write: a few minutes old is fine. */
const BALANCE_TTL_MS = 5 * 60_000;
/** TTLs move by days; each read is two RPC calls, which a keyed provider may bill. */
const CONTRACT_TTL_MS = 10 * 60_000;

/**
 * Built on first use, inside a check: a malformed SOROBAN_RPC_URL then
 * fails that check (logged with logError, which masks the URL) rather than
 * the whole report.
 */
let rpcServer: rpc.Server | undefined;
const server = () => (rpcServer ??= new rpc.Server(RPC_URL));

const cachedBalance = memoize(getAccountBalance, BALANCE_TTL_MS);
const cachedContractTtl = memoize((id) => readContractTtl(server(), id), CONTRACT_TTL_MS);

/** The live dependencies. `admin` is the service-role client. */
export function liveOpsDeps(admin: SupabaseClient): OpsDeps {
  return {
    now: () => Date.now(),
    config: {
      network: NETWORK,
      relayer: DOQTRI_RELAYER,
      registry: CONTRACT_ID,
      market: MARKET_CONTRACT_ID,
      feeForwarder: FEE_FORWARDER,
      horizonUrl: HORIZON_URL,
      registryEditors: REGISTRY_EDITORS,
      dedicatedRpc: Boolean(process.env.SOROBAN_RPC_URL?.trim()),
      expertApiUrl: expertApiContractUrl(CONTRACT_ID),
    },
    snapshot: once(async () => {
      const { data, error } = await admin.rpc("ops_snapshot");
      if (error) throw new Error(`ops_snapshot failed: ${error.message}`);
      if (typeof data !== "object" || data === null) throw new Error("ops_snapshot answered nothing");
      return data as OpsSnapshot;
    }),
    channelKeys: async () => {
      const { data, error } = await admin.from("relay_channels").select("public_key").eq("network", NETWORK).order("idx");
      if (error) throw new Error(`reading relay_channels failed: ${error.message}`);
      return (data ?? []).map((row) => row.public_key as string);
    },
    balance: cachedBalance,
    contractTtl: cachedContractTtl,
    rpcHealth: async () => server().getHealth(),
    // Aborted with the check's own timeout, so a hung probe does not outlive it.
    fetch: (input, init) => fetch(input, { ...init, cache: "no-store", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }),
  };
}
