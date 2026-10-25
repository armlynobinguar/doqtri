import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import type { ChainWorkspace } from "@/lib/stellar/workspace-chain";

/*
 * getDocumentHistory end to end for a workspace note (WP-1.8 review, WP-1.10):
 * the registry, doqtri's write index, the RPC event scan and Horizon are all
 * stood in, so what is checked is how the sources are merged and filtered,
 * and when the page is told history may be partial. REGISTRY_EDITORS is on.
 */

const state = vi.hoisted(() => ({
  document: null as { version: number; owner: string } | null,
  workspace: null as string | null,
  chainWorkspace: (async () => null) as () => Promise<ChainWorkspace | null>,
  readWorkspaceCalls: 0,
  indexed: [] as { tx_hash: string }[],
  rpcHealth: (async () => ({ oldestLedger: 1, latestLedger: 1 })) as () => Promise<{ oldestLedger: number; latestLedger: number }>,
  events: [] as unknown[],
}));

vi.mock("@/lib/stellar/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stellar/config")>()),
  REGISTRY_EDITORS: true,
}));

vi.mock("@/lib/stellar/contract-client", () => ({
  DoqtriRegistry: {
    readDocument: async () => state.document,
    readDocWorkspace: async () => state.workspace,
    readWorkspace: async () => {
      state.readWorkspaceCalls++;
      return state.chainWorkspace();
    },
  },
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => {
    const query = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: async () => ({ data: state.indexed, error: null }),
    };
    return { from: () => query };
  },
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  class Server {
    getHealth() {
      return state.rpcHealth();
    }
    async getEvents(request: { startLedger?: number; endLedger?: number }) {
      const events = (state.events as { ledger: number }[]).filter(
        (e) => e.ledger >= (request.startLedger ?? 0) && e.ledger < (request.endLedger ?? Infinity),
      );
      return { events, cursor: "" };
    }
  }
  return { ...sdk, rpc: { ...sdk.rpc, Server } };
});

const { CONTRACT_ID, HORIZON_URL, LEGACY_CONTRACT_IDS } = await import("@/lib/stellar/config");
const { getDocumentHistory, MAX_REMOVED_FEEDS } = await import("@/lib/stellar/history");
type HorizonOperation = import("@/lib/stellar/history").HorizonOperation;

const DOC = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const WORKSPACE = "7a000000-0000-4000-8000-0000000000b1";
const OWNER = Keypair.random().publicKey();
const REMOVED = Keypair.random().publicKey();
/** A registry history still reads, which anyone can write a doc id into. */
const LEGACY = LEGACY_CONTRACT_IDS[0];

const LATEST = 200_000;
/** One ledger every 5 s, the latest closing now. */
const BASE = Date.now() - LATEST * 5000;
const closedAt = (ledger: number) => new Date(BASE + ledger * 5000).toISOString();
const ledgerAt = (time: number) => Math.floor((time - BASE) / 5000);

const b64 = (v: xdr.ScVal) => v.toXDR("base64");
const str = (s: string) => nativeToScVal(s, { type: "string" });
const bytes = (byte: number) => xdr.ScVal.scvBytes(Buffer.alloc(32, byte));
const as = (who: string) => new Address(who).toScVal();
const status = (tag: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(tag)]);

/** A Horizon invoke_host_function record at `ledger`. */
function call(fn: string, args: xdr.ScVal[], ledger: number, tx: string, contract = CONTRACT_ID): HorizonOperation {
  return {
    type: "invoke_host_function",
    transaction_successful: true,
    transaction_hash: tx,
    created_at: closedAt(ledger),
    paging_token: (BigInt(ledger) << BigInt(32)).toString(),
    parameters: [
      { type: "Address", value: b64(new Address(contract).toScVal()) },
      { type: "Sym", value: b64(xdr.ScVal.scvSymbol(fn)) },
      ...args.map((a) => ({ type: "Unknown", value: b64(a) })),
    ],
  };
}

/** A `*_as` event naming `signer`, for the transaction `tx`. */
function event(signer: string, tx: string, ledger: number) {
  return {
    topic: [xdr.ScVal.scvSymbol("doqtri"), xdr.ScVal.scvSymbol("update"), as(signer)],
    value: str(DOC),
    txHash: tx,
    inSuccessfulContractCall: true,
    ledger,
  };
}

/** Horizon: account feeds (read forward from their cursor), transactions and ledgers. */
function horizon(feeds: Record<string, HorizonOperation[]>, transactions: Record<string, HorizonOperation[]> = {}) {
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input);
    const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code });
    if (!input.startsWith(HORIZON_URL)) return json({}, 500);
    if (url.pathname.endsWith("/ledgers")) {
      return json({ _embedded: { records: [{ sequence: LATEST, closed_at: closedAt(LATEST) }] } });
    }
    const ledger = url.pathname.match(/\/ledgers\/(\d+)$/);
    if (ledger) return json({ sequence: Number(ledger[1]), closed_at: closedAt(Number(ledger[1])) });
    const account = url.pathname.match(/\/accounts\/([A-Z0-9]+)\/operations$/);
    if (account) {
      const feed = feeds[account[1]];
      if (!feed) return json({ status: 404 }, 404);
      const after = BigInt(url.searchParams.get("cursor") ?? "0");
      const page = feed.filter((o) => BigInt(o.paging_token!) > after).slice(0, 200);
      const next = page.length
        ? `${HORIZON_URL}/accounts/${account[1]}/operations?order=asc&limit=200&cursor=${page[page.length - 1].paging_token}`
        : undefined;
      return json({ _embedded: { records: page }, _links: { next: { href: next } } });
    }
    const tx = url.pathname.match(/\/transactions\/([^/]+)\/operations$/);
    if (tx) {
      const ops = transactions[tx[1]];
      return ops ? json({ _embedded: { records: ops } }) : json({ status: 404 }, 404);
    }
    return json({}, 404);
  });
}

const register = call("register_document", [as(OWNER), str(DOC), bytes(1)], 100, "reg");

/**
 * A removed member's feed after their removal at `removedLedger`: writes
 * forged on the legacy registry, an owner-only update on this one, a write
 * naming the owner, and the member's own update_document_as.
 */
function removedFeed(removedLedger: number) {
  return [
    call("register_document", [as(REMOVED), str(DOC), bytes(9)], removedLedger + 1, "forged-reg", LEGACY),
    call("update_document", [str(DOC), bytes(9)], removedLedger + 2, "forged-update", LEGACY),
    call("set_node_status", [str(DOC), str("h0"), status("Built"), str("n8n"), str("wf")], removedLedger + 3, "forged-status", LEGACY),
    call("update_document", [str(DOC), bytes(7)], removedLedger + 4, "owner-only-here"),
    call("update_document_as", [as(OWNER), str(DOC), bytes(6)], removedLedger + 5, "names-owner"),
    call("update_document_as", [as(REMOVED), str(DOC), bytes(2)], removedLedger + 6, "own-late"),
  ];
}

beforeEach(() => {
  state.document = { version: 2, owner: OWNER };
  state.workspace = WORKSPACE;
  state.chainWorkspace = async () => ({ owner: OWNER, members: {} });
  state.readWorkspaceCalls = 0;
  state.indexed = [];
  state.rpcHealth = async () => ({ oldestLedger: LATEST - 100_000, latestLedger: LATEST });
  state.events = [];
});

afterEach(() => vi.unstubAllGlobals());

describe("getDocumentHistory for a workspace note", () => {
  const removedAt = closedAt(LATEST - 1000);

  it("runs against the testnet registry, which has a legacy one", () => {
    expect(LEGACY).toMatch(/^C[A-Z2-7]{55}$/);
    expect(LEGACY).not.toBe(CONTRACT_ID);
  });

  it("keeps only a removed member's own *_as write from their feed and the event transactions", async () => {
    // An event names the removed member for a transaction that holds only an
    // owner-only update: it must not be credited to anyone.
    const evented = call("update_document", [str(DOC), bytes(5)], LATEST - 500, "event-owner-only");
    state.events = [event(REMOVED, "event-owner-only", LATEST - 500)];
    horizon({ [OWNER]: [register], [REMOVED]: removedFeed(LATEST - 1000) }, { "event-owner-only": [evented] });

    const history = await getDocumentHistory(DOC, { removedSigners: [{ address: REMOVED, removedAt }] });
    expect(history?.versions.map((v) => [v.version, v.txHash, v.signer, v.signerFrom])).toEqual([
      [1, "reg", OWNER, "call"],
      [2, "own-late", REMOVED, "call"],
    ]);
    expect(history?.nodeEvents).toEqual([]);
    expect(history?.workspace).toBe(WORKSPACE);
    expect(history?.partial).toBeUndefined();
    expect(history?.incomplete).toBeUndefined();
    // The window has not closed yet: the chain's editor list is not needed.
    expect(state.readWorkspaceCalls).toBe(0);
  });

  it("is partial when the event scan is unreachable", async () => {
    state.rpcHealth = async () => Promise.reject(new Error("RPC down"));
    horizon({ [OWNER]: [register], [REMOVED]: removedFeed(LATEST - 1000) });

    const history = await getDocumentHistory(DOC, { removedSigners: [{ address: REMOVED, removedAt }] });
    expect(history?.partial).toBe(true);
    expect(history?.versions.map((v) => v.txHash)).toEqual(["reg", "own-late"]);
  });

  it(`is partial when more than ${MAX_REMOVED_FEEDS} members were removed`, async () => {
    const removals = Array.from({ length: MAX_REMOVED_FEEDS + 1 }, () => ({
      address: Keypair.random().publicKey(),
      removedAt,
    }));
    state.document = { version: 1, owner: OWNER };
    horizon({ [OWNER]: [register] });

    const history = await getDocumentHistory(DOC, { removedSigners: removals });
    expect(history?.partial).toBe(true);

    const within = await getDocumentHistory(DOC, { removedSigners: removals.slice(0, MAX_REMOVED_FEEDS) });
    expect(within?.partial).toBeUndefined();
  });

  describe("when the removal's day has passed (WP-1.10)", () => {
    const removedLedger = ledgerAt(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const lateLedger = ledgerAt(Date.now() - 24 * 60 * 60 * 1000);
    const removal = { address: REMOVED, removedAt: closedAt(removedLedger) };
    const lateStatus = call(
      "set_node_status_as",
      [as(REMOVED), str(DOC), str("h1"), status("Built"), str("n8n"), str("wf_9")],
      lateLedger,
      "late-status",
    );

    it("reads on to now for a member the chain still lists, so a failed revoke's writes show", async () => {
      state.chainWorkspace = async () => ({ owner: OWNER, members: { [REMOVED]: "editor" } });
      horizon({ [OWNER]: [register], [REMOVED]: [...removedFeed(removedLedger), lateStatus] });

      const history = await getDocumentHistory(DOC, { removedSigners: [removal] });
      expect(state.readWorkspaceCalls).toBe(1);
      expect(history?.nodeEvents.map((e) => [e.nodeId, e.txHash, e.signer])).toEqual([["h1", "late-status", REMOVED]]);
      expect(history?.versions.map((v) => v.txHash)).toEqual(["reg", "own-late"]);
      expect(history?.partial).toBeUndefined();
    });

    it("stops at the day for a member the chain no longer lists, whose revocation was done within it", async () => {
      // A later write in their feed stands in for what the day's bound cuts off.
      const revokedAt = closedAt(removedLedger + 120);
      horizon({ [OWNER]: [register], [REMOVED]: [...removedFeed(removedLedger), lateStatus] });

      const history = await getDocumentHistory(DOC, { removedSigners: [{ ...removal, revokedAt }] });
      expect(state.readWorkspaceCalls).toBe(1);
      expect(history?.nodeEvents).toEqual([]);
      expect(history?.versions.map((v) => v.txHash)).toEqual(["reg", "own-late"]);
      expect(history?.partial).toBeUndefined();
    });

    describe("a revocation that reached the chain more than a week late (review)", () => {
      // Removed ten days ago; their revoke failed until two days ago. The
      // status write nine days ago is outside the RPC's event window
      // (oldestLedger is about six days back), so only their feed has it.
      const longAgo = ledgerAt(Date.now() - 10 * 24 * 60 * 60 * 1000);
      const weekOld = ledgerAt(Date.now() - 9 * 24 * 60 * 60 * 1000);
      const oldRemoval = { address: REMOVED, removedAt: closedAt(longAgo) };
      const oldStatus = call(
        "set_node_status_as",
        [as(REMOVED), str(DOC), str("h2"), status("Built"), str("n8n"), str("wf_7")],
        weekOld,
        "week-old-status",
      );
      const feed = () => [...removedFeed(longAgo), oldStatus];

      it("is outside the event window, so only the feed can find it", () => {
        expect(weekOld).toBeLessThan(LATEST - 100_000);
      });

      it("reads on to when the revocation was done", async () => {
        const revokedAt = closedAt(ledgerAt(Date.now() - 2 * 24 * 60 * 60 * 1000));
        horizon({ [OWNER]: [register], [REMOVED]: feed() });

        const history = await getDocumentHistory(DOC, { removedSigners: [{ ...oldRemoval, revokedAt }] });
        expect(history?.nodeEvents.map((e) => [e.nodeId, e.txHash, e.signer])).toEqual([["h2", "week-old-status", REMOVED]]);
        expect(history?.versions.map((v) => v.txHash)).toEqual(["reg", "own-late"]);
        expect(history?.partial).toBeUndefined();
      });

      it("reads on to now when doqtri has no record of the revocation being done", async () => {
        horizon({ [OWNER]: [register], [REMOVED]: feed() });

        const history = await getDocumentHistory(DOC, { removedSigners: [{ ...oldRemoval, revokedAt: null }] });
        expect(history?.nodeEvents.map((e) => e.txHash)).toEqual(["week-old-status"]);
        expect(history?.partial).toBeUndefined();
      });

      it("is partial when reading on runs out of pages first", async () => {
        // Their feed is busy after the removal: more than the page budget of
        // unrelated operations before the write.
        const busy = Array.from({ length: 10 * 200 + 1 }, (_, i) =>
          call("update_document", [str(`other-${i}`), bytes(3)], longAgo + 10 + i, `busy-${i}`),
        );
        horizon({ [OWNER]: [register], [REMOVED]: [...busy, oldStatus] });

        const history = await getDocumentHistory(DOC, { removedSigners: [oldRemoval] });
        expect(history?.nodeEvents).toEqual([]);
        expect(history?.partial).toBe(true);
      });
    });

    it("is partial when the chain's editor list cannot be read", async () => {
      state.chainWorkspace = async () => Promise.reject(new Error("RPC down"));
      horizon({ [OWNER]: [register], [REMOVED]: [...removedFeed(removedLedger), lateStatus] });

      const history = await getDocumentHistory(DOC, { removedSigners: [removal] });
      expect(history?.partial).toBe(true);
      expect(history?.versions.map((v) => v.txHash)).toEqual(["reg", "own-late"]);
    });

    it("reads a member restored after the day up to the restoration", async () => {
      const restoredAt = closedAt(lateLedger + 10);
      horizon({ [OWNER]: [register], [REMOVED]: [...removedFeed(removedLedger), lateStatus] });

      const history = await getDocumentHistory(DOC, { removedSigners: [{ ...removal, restoredAt }] });
      expect(state.readWorkspaceCalls).toBe(0);
      expect(history?.nodeEvents.map((e) => e.txHash)).toEqual(["late-status"]);
    });
  });
});
