import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HackathonGlobalMindmap } from "@/lib/integrations/qdit-hackathon";

/*
 * The server half of mindmap links (WP-4.7, DOQ-53): tokens, the style stored
 * with a link, and the anonymous read the /m/<token> page makes.
 */

const rpc = vi.hoisted(() => vi.fn());
const created = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock("@supabase/supabase-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@supabase/supabase-js")>()),
  createClient: (url: string, key: string, options: unknown) => {
    created.options.push({ url, key, options });
    return { rpc };
  },
}));

const { hiddenNodeIds, insertMindmapShare, loadMindmapShare, newShareToken, opaqueIds, shareStyle } = await import(
  "@/lib/mindmap-share-server"
);
const { SHARE_TOKEN_PATTERN } = await import("@/lib/mindmap-share");

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

beforeEach(() => {
  rpc.mockReset();
  created.options = [];
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
});

describe("newShareToken", () => {
  it("is 32 base64url characters: 192 bits from the CSPRNG", () => {
    const token = newShareToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(SHARE_TOKEN_PATTERN.test(token)).toBe(true);
    expect(Buffer.from(token, "base64url")).toHaveLength(24);
  });

  it("never repeats", () => {
    const tokens = new Set(Array.from({ length: 2000 }, () => newShareToken()));
    expect(tokens.size).toBe(2000);
  });
});

const GRAPH: HackathonGlobalMindmap = {
  nodes: [
    { id: "doc:10000000-0000-4000-8000-000000000001", label: "Plan", kind: "document", depth: 0, doc_ids: [] },
    { id: `c:${"0".repeat(16)}`, label: "x", kind: "concept", depth: 1, doc_ids: [] },
  ],
  links: [],
};

describe("shareStyle", () => {
  it("is null when the sender never restyled the map", () => {
    expect(shareStyle(null, GRAPH)).toBeNull();
  });

  it("parses the stored style, and keeps overrides only for nodes the snapshot has", () => {
    const style = shareStyle(
      {
        preset: "aurora",
        textScale: 1.4,
        unknownField: "dropped",
        overrides: {
          "doc:10000000-0000-4000-8000-000000000001": { color: "#ff0000" },
          "concept:gone": { hidden: true },
        },
      },
      GRAPH,
    )!;
    expect(style.textScale).toBe(1.4);
    expect(style).not.toHaveProperty("unknownField");
    expect(style.overrides).toEqual({ "doc:10000000-0000-4000-8000-000000000001": { color: "#ff0000" } });
  });

  it("keys an override on a long id by the shortened id the snapshot sends", async () => {
    const { wireNodeId } = await import("@/lib/integrations/qdit-hackathon");
    const long = `concept:${"a".repeat(200)}`;
    const graph: HackathonGlobalMindmap = {
      nodes: [{ id: wireNodeId(long), label: "a", kind: "concept", depth: 1, doc_ids: [] }],
      links: [],
    };
    expect(shareStyle({ overrides: { [long]: { scale: 2 } } }, graph)!.overrides).toEqual({ [wireNodeId(long)]: { scale: 2 } });
  });
});

describe("opaqueIds", () => {
  it("renames every node, and its links and overrides with it", () => {
    const out = opaqueIds(
      {
        nodes: [
          { id: "doc:1", label: "Plan", kind: "document", depth: 0 },
          { id: "concept:x", label: "X", kind: "concept", depth: 1 },
        ],
        links: [{ source: "doc:1", target: "concept:x" }],
      },
      { preset: "aurora", overrides: { "concept:x": { color: "#00ff00" }, "doc:gone": { hidden: true } } },
    );
    expect(out.graph).toEqual({
      nodes: [
        { id: "n0", label: "Plan", kind: "document", depth: 0 },
        { id: "n1", label: "X", kind: "concept", depth: 1 },
      ],
      links: [{ source: "n0", target: "n1" }],
    });
    expect(out.style).toEqual({ preset: "aurora", overrides: { n1: { color: "#00ff00" } } });
  });

  it("leaves a missing style missing", () => {
    expect(opaqueIds({ nodes: [], links: [] }, null).style).toBeNull();
  });
});

describe("loadMindmapShare", () => {
  const ROW = {
    graph: {
      nodes: [{ id: "doc:10000000-0000-4000-8000-000000000001", label: "Plan", kind: "document", depth: 0 }],
      links: [],
    },
    style: null,
    created_at: "2026-11-12T09:00:00Z",
  };

  it("reads with the anon key and no session, through mindmap_share()", async () => {
    rpc.mockResolvedValue({ data: [ROW], error: null });
    const share = await loadMindmapShare(TOKEN);
    expect(rpc).toHaveBeenCalledWith("mindmap_share", { p_token: TOKEN });
    expect(created.options).toEqual([
      {
        url: "https://supabase.test",
        key: "anon-key",
        options: { auth: { persistSession: false, autoRefreshToken: false } },
      },
    ]);
    expect(share).toEqual({
      graph: { nodes: [{ id: "n0", label: "Plan", kind: "document", depth: 0 }], links: [] },
      style: null,
      createdAt: "2026-11-12T09:00:00Z",
    });
    expect(JSON.stringify(share)).not.toContain("10000000-0000-4000-8000-000000000001");
  });

  it("is null for an unknown or revoked token (no row)", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    expect(await loadMindmapShare(TOKEN)).toBeNull();
  });

  it("is null for a malformed token, without asking", async () => {
    expect(await loadMindmapShare("short")).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("throws when the read fails, rather than calling the link unknown", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "timeout" } });
    await expect(loadMindmapShare(TOKEN)).rejects.toThrow(/timeout/);
  });
});

describe("hiddenNodeIds (DOQ-54)", () => {
  it("is the ids the stored global style hides, and only those", () => {
    const raw = {
      overrides: {
        "concept:secret": { hidden: true },
        "doc:x": { hidden: false, color: "#ff0000" },
        "concept:loud": { color: "#00ff00" },
        "concept:odd": { hidden: "yes" },
      },
    };
    expect([...hiddenNodeIds(raw)]).toEqual(["concept:secret"]);
  });

  it("is empty for no style, or one that does not parse", () => {
    expect(hiddenNodeIds(null).size).toBe(0);
    expect(hiddenNodeIds(undefined).size).toBe(0);
    expect(hiddenNodeIds("nonsense").size).toBe(0);
    expect(hiddenNodeIds({ overrides: [] }).size).toBe(0);
  });
});

describe("insertMindmapShare", () => {
  it("stores the hackathon the link is sent to (DOQ-54)", async () => {
    const inserted: unknown[] = [];
    const admin = {
      from: () => ({
        insert: (row: unknown) => {
          inserted.push(row);
          return { select: () => ({ single: async () => ({ data: { id: "id-1" }, error: null }) }) };
        },
      }),
    };
    const graph: HackathonGlobalMindmap = { nodes: [], links: [] };
    await insertMindmapShare(admin as never, {
      token: TOKEN,
      workspaceId: "w",
      createdBy: "u",
      snapshotId: "s",
      hackathonSlug: "spring-2026",
      graph,
      style: null,
    });
    expect(inserted).toEqual([expect.objectContaining({ hackathon_slug: "spring-2026", snapshot_id: "s" })]);
  });
});
