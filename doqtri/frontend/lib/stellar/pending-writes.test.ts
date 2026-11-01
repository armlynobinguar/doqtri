import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ledgerLookup,
  PENDING_WRITE_EXPIRY_MS,
  reconcilePendingWrites,
  supabasePendingWriteStore,
  type LedgerStatus,
  type PendingWrite,
  type PendingWriteStore,
} from "@/lib/stellar/pending-writes";
import { HORIZON_URL } from "@/lib/stellar/config";

/*
 * Settling the paid writes the relay answered 202 for (DOQ-5), against an
 * in-memory chain_writes and a scripted ledger.
 */

const now = Date.parse("2026-11-01T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const tx = (n: number) => n.toString(16).padStart(64, "0");

/** chain_writes rows by hash; settle only moves a row that is still pending. */
function memoryStore(rows: Record<string, PendingWrite & { status: string }>) {
  const store: PendingWriteStore & { rows: typeof rows; asked: number[] } = {
    rows,
    asked: [],
    async pending(limit) {
      store.asked.push(limit);
      return Object.values(rows)
        .filter((r) => r.status === "pending")
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, limit);
    },
    async settle(hash, status) {
      if (rows[hash]?.status !== "pending") return false;
      rows[hash].status = status;
      return true;
    },
  };
  return store;
}

const row = (n: number, createdAgoMs: number, status = "pending") => ({
  [tx(n)]: { tx_hash: tx(n), created_at: ago(createdAgoMs), status },
});

/** A ledger that answers `statuses` by hash and NOT_FOUND otherwise. */
const ledger = (statuses: Record<string, LedgerStatus | Error>) => async (hash: string) => {
  const status = statuses[hash] ?? "NOT_FOUND";
  if (status instanceof Error) throw status;
  return status;
};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reconcilePendingWrites", () => {
  it("marks a pending write confirmed once the ledger has it", async () => {
    const store = memoryStore(row(1, 30_000));
    const summary = await reconcilePendingWrites(store, ledger({ [tx(1)]: "SUCCESS" }), { now: () => now });
    expect(store.rows[tx(1)].status).toBe("confirmed");
    expect(summary).toEqual({ confirmed: 1, failed: 0, pending: 0 });
  });

  it("marks it failed when it failed on-chain", async () => {
    const store = memoryStore(row(1, 30_000));
    const summary = await reconcilePendingWrites(store, ledger({ [tx(1)]: "FAILED" }), { now: () => now });
    expect(store.rows[tx(1)].status).toBe("failed");
    expect(summary).toEqual({ confirmed: 0, failed: 1, pending: 0 });
  });

  it("leaves a write not found pending while it could still land, then fails it once its time bound has certainly passed", async () => {
    const store = memoryStore({ ...row(1, 90_000), ...row(2, PENDING_WRITE_EXPIRY_MS - 1_000), ...row(3, PENDING_WRITE_EXPIRY_MS + 1_000) });
    const summary = await reconcilePendingWrites(store, ledger({}), { now: () => now });
    // Well past the 60 s time bound, but inside the margin: still pending.
    expect(store.rows[tx(1)].status).toBe("pending");
    expect(store.rows[tx(2)].status).toBe("pending");
    expect(store.rows[tx(3)].status).toBe("failed");
    expect(summary).toEqual({ confirmed: 0, failed: 1, pending: 2 });
  });

  it("fails a write once the same row's time runs out on a later run", async () => {
    const store = memoryStore(row(1, 60_000));
    let clock = now;
    await reconcilePendingWrites(store, ledger({}), { now: () => clock });
    expect(store.rows[tx(1)].status).toBe("pending");
    clock += PENDING_WRITE_EXPIRY_MS;
    await reconcilePendingWrites(store, ledger({}), { now: () => clock });
    expect(store.rows[tx(1)].status).toBe("failed");
  });

  it("leaves a write pending when the lookup errors, even past expiry, and carries on with the rest", async () => {
    const store = memoryStore({ ...row(1, PENDING_WRITE_EXPIRY_MS * 2), ...row(2, 30_000) });
    const summary = await reconcilePendingWrites(
      store,
      ledger({ [tx(1)]: new Error("socket hang up"), [tx(2)]: "SUCCESS" }),
      { now: () => now },
    );
    expect(store.rows[tx(1)].status).toBe("pending");
    expect(store.rows[tx(2)].status).toBe("confirmed");
    expect(summary).toEqual({ confirmed: 1, failed: 0, pending: 1 });
  });

  it("counts a row another run settled first as pending here, and changes nothing", async () => {
    const store = memoryStore(row(1, 30_000));
    store.settle = async () => false;
    const summary = await reconcilePendingWrites(store, ledger({ [tx(1)]: "SUCCESS" }), { now: () => now });
    expect(summary).toEqual({ confirmed: 0, failed: 0, pending: 1 });
  });

  it("reads only pending rows, at most `limit` of them", async () => {
    const store = memoryStore({ ...row(1, 30_000, "confirmed"), ...row(2, 20_000), ...row(3, 10_000) });
    const asked: string[] = [];
    await reconcilePendingWrites(
      store,
      async (hash) => {
        asked.push(hash);
        return "SUCCESS";
      },
      { now: () => now, limit: 1 },
    );
    expect(store.asked).toEqual([1]);
    expect(asked).toEqual([tx(2)]);
    expect(store.rows[tx(3)].status).toBe("pending");
  });
});

describe("ledgerLookup", () => {
  const server = (status: string) => ({ getTransaction: async () => ({ status }) }) as never;

  it("takes the RPC's SUCCESS and FAILED as they are, without asking Horizon", async () => {
    const fetchImpl = vi.fn();
    expect(await ledgerLookup(server("SUCCESS"), fetchImpl)(tx(1))).toBe("SUCCESS");
    expect(await ledgerLookup(server("FAILED"), fetchImpl)(tx(1))).toBe("FAILED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks an RPC NOT_FOUND against Horizon, which keeps every transaction", async () => {
    const answers: Record<string, Response> = {
      [tx(1)]: Response.json({ successful: true }),
      [tx(2)]: Response.json({ successful: false }),
      [tx(3)]: new Response("", { status: 404 }),
    };
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return answers[url.split("/").pop()!];
    }) as unknown as typeof fetch;
    const lookup = ledgerLookup(server("NOT_FOUND"), fetchImpl);
    expect(await lookup(tx(1))).toBe("SUCCESS");
    expect(await lookup(tx(2))).toBe("FAILED");
    expect(await lookup(tx(3))).toBe("NOT_FOUND");
    expect(urls[0]).toBe(`${HORIZON_URL}/transactions/${tx(1)}`);
  });

  it("throws when Horizon can't answer, so the row waits for the next run", async () => {
    const fetchImpl = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(ledgerLookup(server("NOT_FOUND"), fetchImpl)(tx(1))).rejects.toThrow("Horizon answered 503");
  });
});

describe("supabasePendingWriteStore", () => {
  /** Records the filters each chained query was given. */
  function fakeAdmin(result: { data: unknown; error: { message: string } | null }) {
    const calls: { table: string; ops: [string, ...unknown[]][] }[] = [];
    const admin = {
      from(table: string) {
        const entry = { table, ops: [] as [string, ...unknown[]][] };
        calls.push(entry);
        const query: Record<string, (...args: unknown[]) => unknown> = {};
        for (const op of ["select", "eq", "order", "update"]) {
          query[op] = (...args: unknown[]) => {
            entry.ops.push([op, ...args]);
            return query;
          };
        }
        query.limit = async (...args: unknown[]) => {
          entry.ops.push(["limit", ...args]);
          return result;
        };
        // update(...).eq(...).select(...) resolves at select.
        query.select = (...args: unknown[]) => {
          entry.ops.push(["select", ...args]);
          return entry.ops.some(([op]) => op === "update") ? Promise.resolve(result) : query;
        };
        return query;
      },
    };
    return { admin: admin as unknown as SupabaseClient, calls };
  }

  it("reads this network's pending rows, oldest first", async () => {
    const { admin, calls } = fakeAdmin({ data: [{ tx_hash: tx(1), created_at: ago(0) }], error: null });
    const rows = await supabasePendingWriteStore(admin, "testnet").pending(50);
    expect(rows).toEqual([{ tx_hash: tx(1), created_at: ago(0) }]);
    expect(calls[0].table).toBe("chain_writes");
    expect(calls[0].ops).toEqual([
      ["select", "tx_hash, created_at"],
      ["eq", "network", "testnet"],
      ["eq", "status", "pending"],
      ["order", "created_at", { ascending: true }],
      ["limit", 50],
    ]);
  });

  it("settles a row only while it is still pending", async () => {
    const { admin, calls } = fakeAdmin({ data: [{ tx_hash: tx(1) }], error: null });
    expect(await supabasePendingWriteStore(admin, "testnet").settle(tx(1), "confirmed")).toBe(true);
    expect(calls[0].ops).toEqual([
      ["update", { status: "confirmed" }],
      ["eq", "network", "testnet"],
      ["eq", "tx_hash", tx(1)],
      ["eq", "status", "pending"],
      ["select", "tx_hash"],
    ]);
    const settled = fakeAdmin({ data: [], error: null });
    expect(await supabasePendingWriteStore(settled.admin, "testnet").settle(tx(1), "failed")).toBe(false);
  });
});
