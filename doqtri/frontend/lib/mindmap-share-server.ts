import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { defaultStyleFor, parseStyle, type MindmapStyle, type NodeOverride } from "@/lib/mindmap-style";
import { wireNodeId, type HackathonGlobalMindmap } from "@/lib/integrations/qdit-hackathon";
import { parseSharedGraph, SHARE_TOKEN_PATTERN } from "@/lib/mindmap-share";
import type { MindmapGraph } from "@/lib/mindmap-graph";

/**
 * Making and revoking public mindmap links (WP-4.7, DOQ-53). Server-only:
 * the token comes from node:crypto, and the writes take the service role.
 * mindmap-share.ts has the parts the browser and proxy.ts share.
 */

/** Bytes of randomness in a token: 24 (192 bits), which base64url writes as 32 characters. */
const TOKEN_BYTES = 24;

/** A new link token from the operating system's CSPRNG: 192 bits, base64url, 32 characters. */
export function newShareToken(): string {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  // Cannot happen with 24 bytes; the column's check would refuse it anyway.
  if (!SHARE_TOKEN_PATTERN.test(token)) throw new Error("bad share token");
  return token;
}

/**
 * The sender's `global` studio style as the link shows it: their stored row
 * parsed as the global mindmap parses it (unknown fields dropped, bad values
 * back to the default), with each per-node override keyed by the node's id
 * in the snapshot (wireNodeId: ids over 128 characters are shortened) and
 * only for nodes the snapshot has. Null when they never restyled the map, so
 * the page shows the global map's default look.
 */
export function shareStyle(raw: unknown, graph: HackathonGlobalMindmap): MindmapStyle | null {
  if (raw === null || raw === undefined) return null;
  const style = parseStyle(raw, defaultStyleFor("free"));
  const ids = new Set(graph.nodes.map((node) => node.id));
  const overrides: Record<string, NodeOverride> = {};
  for (const [id, override] of Object.entries(style.overrides)) {
    const wire = wireNodeId(id);
    if (ids.has(wire)) overrides[wire] = override;
  }
  return { ...style, overrides };
}

export type NewMindmapShare = {
  token: string;
  workspaceId: string;
  createdBy: string;
  snapshotId: string;
  graph: HackathonGlobalMindmap;
  style: MindmapStyle | null;
};

/**
 * Stores a link. `admin` MUST be the service-role client, and the caller must
 * already have checked that `createdBy` administers `workspaceId` (D-10):
 * clients have no insert on mindmap_shares. Returns the row's id; throws on
 * any database error.
 */
export async function insertMindmapShare(admin: SupabaseClient, share: NewMindmapShare): Promise<string> {
  const { data, error } = await admin
    .from("mindmap_shares")
    .insert({
      token: share.token,
      workspace_id: share.workspaceId,
      created_by: share.createdBy,
      snapshot_id: share.snapshotId,
      graph: share.graph,
      style: share.style,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to store the mindmap link: ${error?.message ?? "no row"}`);
  return (data as { id: string }).id;
}

/**
 * Revokes the link `id` as the service role: the send route's clean-up after
 * a push that failed. Best effort: it reports whether it worked and never
 * throws, since the push's own failure is what the user is told about.
 */
export async function revokeMindmapShareAsServer(admin: SupabaseClient, id: string): Promise<boolean> {
  try {
    const { error } = await admin
      .from("mindmap_shares")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id);
    return !error;
  } catch {
    return false;
  }
}

export type LoadedMindmapShare = {
  graph: MindmapGraph;
  /** The stored style, not yet parsed; null when the sender never restyled the map. */
  style: unknown;
  createdAt: string;
};

/**
 * The live link `token`, read the way anyone without an account reads it:
 * a client with the anon key and no session, through mindmap_share(), which
 * answers only a link that is not revoked, with labels only. Null for a
 * malformed, unknown or revoked token. Throws when the read itself fails, so
 * the page shows an error rather than claiming the link does not exist.
 */
export async function loadMindmapShare(token: string): Promise<LoadedMindmapShare | null> {
  if (!SHARE_TOKEN_PATTERN.test(token)) return null;
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await anon.rpc("mindmap_share", { p_token: token });
  if (error) throw new Error(`Failed to read the mindmap link: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { graph: unknown; style: unknown; created_at: string }
    | null
    | undefined;
  if (!row) return null;
  const graph = parseSharedGraph(row.graph);
  if (!graph) return null;
  return { ...opaqueIds(graph, row.style ?? null), createdAt: row.created_at };
}

/**
 * The graph and style with every node id replaced by `n<index>`, links and
 * per-node style overrides following. A note's node id is `doc:<note id>`, and
 * the page needs no note ids: the browser gets labels and shape only.
 */
export function opaqueIds(graph: MindmapGraph, style: unknown): { graph: MindmapGraph; style: unknown } {
  const ids = new Map(graph.nodes.map((node, i) => [node.id, `n${i}`]));
  const opaque: MindmapGraph = {
    nodes: graph.nodes.map((node) => ({ ...node, id: ids.get(node.id)! })),
    links: graph.links.map((link) => ({ source: ids.get(link.source)!, target: ids.get(link.target)! })),
  };
  if (!style || typeof style !== "object" || Array.isArray(style)) return { graph: opaque, style };
  const raw = style as Record<string, unknown>;
  const overrides: Record<string, unknown> = {};
  if (raw.overrides && typeof raw.overrides === "object" && !Array.isArray(raw.overrides)) {
    for (const [id, override] of Object.entries(raw.overrides as Record<string, unknown>)) {
      const next = ids.get(id);
      if (next) overrides[next] = override;
    }
  }
  return { graph: opaque, style: { ...raw, overrides } };
}
