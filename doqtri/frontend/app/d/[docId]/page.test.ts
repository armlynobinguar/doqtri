import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainNodeEvent, DocumentHistory } from "@/lib/stellar/history";

/*
 * The public audit page with and without NEXT_PUBLIC_QDIT_INTEGRATION
 * (WP-3.1). The ledger, Horizon and Supabase are fakes; the page renders to
 * static markup. With the flag unset the page reads nothing new and renders
 * exactly what it did before; with it on, the only change is the receipts
 * section.
 */

const DOC = "30000000-0000-4000-8000-000000000001";
const CONTRACT = "CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG";
const REF = `qdit:testnet:${CONTRACT}:3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34/c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72@v2`;
const SIGNER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const HASH = "ab".repeat(32);

const PROJECT = "3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34";
const MILESTONE = "c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72";

const mocks = vi.hoisted(() => ({
  readNode: vi.fn(),
  readMilestoneRecord: vi.fn(),
  from: vi.fn(),
  history: null as unknown,
  /** The note's doc_project_links row, or null. */
  projectLink: null as { project_id: string; project_slug: string } | null,
}));

vi.mock("@/lib/stellar/contract-client", () => ({
  DoqtriRegistry: {
    readDocument: async () => ({ owner: SIGNER, contentHash: HASH, version: 3, updatedAt: 1_792_843_200 }),
    readNode: mocks.readNode,
  },
}));

vi.mock("@/lib/stellar/history", () => ({
  getDocumentHistory: async () => mocks.history,
  getDocumentTtl: async () => null,
}));

// Like the real one: throws when the service-role key is missing.
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseAdminClient: () => {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set.");
    return { rpc: async () => ({ data: [], error: null }), from: mocks.from };
  },
}));

vi.mock("@/lib/integrations/qdit-chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/qdit-chain")>()),
  readMilestoneRecord: mocks.readMilestoneRecord,
}));

function nodeEvent(nodeId: string, tool: string, artifactRef: string, n: number): ChainNodeEvent {
  return {
    nodeId,
    status: "Verified",
    tool,
    artifactRef,
    txHash: n.toString(16).padStart(64, "0"),
    closedAt: "2026-10-24T12:00:00Z",
    docVersion: 3,
    signer: SIGNER,
    signerFrom: "call",
  };
}

function historyWith(nodes: ChainNodeEvent[]): DocumentHistory {
  return {
    owner: SIGNER,
    versions: [{ version: 3, contentHash: HASH, txHash: "f".repeat(64), closedAt: "2026-10-24T11:00:00Z", signer: SIGNER, signerFrom: "call" }],
    nodeEvents: nodes,
    nodes,
  };
}

/** A documents query (publish_headings off), the approvals query and the note's project link. */
function table(name: string) {
  const rows = name === "qdit_milestone_approvals" ? [] : name === "doc_project_links" ? mocks.projectLink : null;
  const query = {
    select: () => query,
    eq: () => query,
    in: async () => ({ data: rows, error: null }),
    maybeSingle: async () => ({ data: rows, error: null }),
  };
  return query;
}

async function render(): Promise<string> {
  const { default: AuditPage } = await import("./page");
  const tree = await AuditPage({ params: Promise.resolve({ docId: DOC }) } as never);
  return renderToStaticMarkup(tree);
}

const RECEIPTS_SECTION = /<section class="grid gap-3" data-testid="qdit-receipts">[\s\S]*?<\/section>/;

beforeEach(() => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  vi.stubEnv("QDIT_API_BASE_URL", "");
  mocks.projectLink = null;
  mocks.history = historyWith([nodeEvent("h1", "github", "github:acme/app#4", 1), nodeEvent("h2", "qdit", REF, 2)]);
  mocks.readNode.mockReset().mockImplementation(async (_doc: string, nodeId: string) => {
    const e = (mocks.history as DocumentHistory).nodes.find((n) => n.nodeId === nodeId);
    return e ? { status: e.status, tool: e.tool, artifactRef: e.artifactRef, updatedAt: 1 } : null;
  });
  mocks.readMilestoneRecord.mockReset().mockResolvedValue({
    ledger: 5000,
    record: { status: "Approved", version: 2, proofHash: HASH, submitter: SIGNER, timestamp: 1 },
  });
  mocks.from.mockReset().mockImplementation(table);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("/d/[docId] and NEXT_PUBLIC_QDIT_INTEGRATION", () => {
  it("unset: no receipts, and nothing qdit-related is read", async () => {
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "");
    const html = await render();
    expect(html).toContain("Build status");
    expect(html).not.toContain("qdit receipts");
    expect(html).not.toContain('data-testid="qdit-receipts"');
    expect(mocks.readNode).not.toHaveBeenCalled();
    expect(mocks.readMilestoneRecord).not.toHaveBeenCalled();
    expect(mocks.from.mock.calls.map(([name]) => name)).not.toContain("qdit_milestone_approvals");
  });

  it("unset, with qdit configured and the note linked: still nothing read, no qdit page asked for", async () => {
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "");
    vi.stubEnv("QDIT_API_BASE_URL", "https://qdit.example/api/v1");
    mocks.projectLink = { project_id: PROJECT, project_slug: "soroban-payroll" };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const html = await render();
    expect(html).not.toContain('data-testid="qdit-receipts"');
    expect(html).not.toContain("qdit.example");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.from.mock.calls.map(([name]) => name)).not.toContain("doc_project_links");
  });

  it("on: the receipts section is the only change to the page", async () => {
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "");
    const off = await render();
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "1");
    const on = await render();
    expect(on).toMatch(RECEIPTS_SECTION);
    expect(on).toContain("Approved on chain");
    expect(on.replace(RECEIPTS_SECTION, "")).toBe(off);
    expect(mocks.readNode).toHaveBeenCalledTimes(1);
    expect(mocks.readNode).toHaveBeenCalledWith(DOC, "h2");
  });

  it("on, with no heading signed from qdit: the page is unchanged", async () => {
    mocks.history = historyWith([nodeEvent("h1", "github", "github:acme/app#4", 1)]);
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "");
    const off = await render();
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "1");
    expect(await render()).toBe(off);
    expect(mocks.readMilestoneRecord).not.toHaveBeenCalled();
  });

  it("on, with the approval store failing: only the approval link is lost", async () => {
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "");
    const off = await render();
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "1");
    mocks.from.mockImplementation((name: string) => {
      if (name === "qdit_milestone_approvals") throw new Error("no admin client");
      return table(name);
    });
    const on = await render();
    expect(on).toContain('data-testid="approval-unrecorded"');
    expect(on.replace(RECEIPTS_SECTION, "")).toBe(off);
  });

  it("on, without the service-role key: the page still renders, with the chain's side of the receipt", async () => {
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "1");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const html = await render();
    expect(html).toContain("Build status");
    expect(html).toMatch(RECEIPTS_SECTION);
    expect(html).toContain("Approved on chain");
    expect(html).toContain('data-testid="approval-unrecorded"');
  });

  it("on, with qdit's origin known: links qdit's milestone page once qdit answers it anonymously", async () => {
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "1");
    vi.stubEnv("QDIT_API_BASE_URL", "https://qdit.example/api/v1");
    mocks.projectLink = { project_id: PROJECT, project_slug: "soroban-payroll" };
    const url = `https://qdit.example/p/soroban-payroll/${MILESTONE}`;
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const html = await render();
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: "manual", credentials: "omit" }));
    expect(html).toContain(`href="${url}"`);
    // The slug appears only inside the URL qdit itself serves.
    expect(html.replaceAll(url, "")).not.toContain("soroban-payroll");
  });
});
