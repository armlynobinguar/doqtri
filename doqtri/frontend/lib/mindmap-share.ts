import type { MapNode, MapNodeKind, MindmapGraph } from "@/lib/mindmap-graph";

/**
 * Public read-only mindmap links (WP-4.7, DOQ-53): what the send route, the
 * /m/<token> page, proxy.ts and the dialog share. Pure and safe for the
 * browser and the proxy; making a token and writing the row are in
 * mindmap-share-server.ts.
 *
 * Every "Send to qdit hackathon" stores the global mindmap exactly as sent
 * (backend migration 20261112100000_mindmap_shares.sql) and puts its link,
 * `mindmap_url`, in the snapshot. qdit (QDIT-66) accepts a `mindmap_url` only
 * when it is https, on qdit's DOQTRI_ORIGIN, with the path exactly
 * `/m/<token>` (22 to 64 of `[A-Za-z0-9_-]`) and no query or fragment, so
 * mindmapShareUrl() builds nothing else.
 */

/** A link's token: base64url, 22 to 64 characters (the column's check says the same). */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

/** The page's path prefix; proxy.ts lets it through signed out. */
export const SHARE_PATH_PREFIX = "/m/";

/**
 * Where proxy.ts rewrites /m/<token> when the token is malformed, unknown or
 * revoked. No route matches it (an underscore folder is private in the app
 * router), so Next answers a real 404 before the root loading.tsx can stream
 * a 200, as for the ended promo (DOQ-50).
 */
export const SHARE_NOT_FOUND_REWRITE = "/_mindmap-share-not-found";

/** The token in a /m/<token> path, or null when the path is not one. */
export function shareTokenFromPath(pathname: string): string | null {
  if (!pathname.startsWith(SHARE_PATH_PREFIX)) return null;
  const rest = pathname.slice(SHARE_PATH_PREFIX.length);
  return SHARE_TOKEN_PATTERN.test(rest) ? rest : null;
}

/**
 * The public link for `token` on `siteUrl` (lib/site-url.ts): `https://<host>/m/<token>`.
 *
 * Only the origin of `siteUrl` is used, so a path, a trailing slash, a query
 * or credentials in it never reach the link, and the host comes out
 * lowercased with any default port dropped, as qdit compares it. Null when
 * the site is not https (a local dev server) or `token` is not one: qdit would
 * refuse the whole snapshot over such a link, so none is made.
 */
export function mindmapShareUrl(siteUrl: string, token: string): string | null {
  if (!SHARE_TOKEN_PATTERN.test(token)) return null;
  let site: URL;
  try {
    site = new URL(siteUrl.trim());
  } catch {
    return null;
  }
  if (site.protocol !== "https:" || !site.hostname) return null;
  return `${site.origin}${SHARE_PATH_PREFIX}${token}`;
}

/**
 * Whether `value` is a link qdit will take as `mindmap_url`, apart from the
 * host, which only qdit knows to check (its DOQTRI_ORIGIN): https, no
 * credentials, the path exactly /m/<token>, nothing after it.
 */
export function isMindmapShareUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    // A bare "?" or "#" parses to an empty search or hash: refuse it too.
    !value.includes("?") &&
    !value.includes("#") &&
    url.href === value &&
    shareTokenFromPath(url.pathname) !== null
  );
}

// ---------------------------------------------------------------------------
// The page's data
// ---------------------------------------------------------------------------

const KINDS: ReadonlySet<string> = new Set<MapNodeKind>([
  "root",
  "theme",
  "concept",
  "detail",
  "document",
  "hub",
]);

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * The graph mindmap_share() answered, as the canvas draws it: nodes with an
 * id, a label, a known kind and a depth (anything else dropped, along with
 * any field the canvas does not need), and links between nodes that are
 * there. Nodes carry no `href` and no `summary`, so nothing on the page opens
 * a note or shows note text. Null when it is not a graph at all.
 */
export function parseSharedGraph(value: unknown): MindmapGraph | null {
  const graph = record(value);
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) return null;

  const nodes: MapNode[] = [];
  const ids = new Set<string>();
  for (const entry of graph.nodes) {
    const node = record(entry);
    if (!node) continue;
    const { id, label, kind, depth } = node;
    if (typeof id !== "string" || !id || ids.has(id)) continue;
    if (typeof label !== "string" || typeof kind !== "string" || !KINDS.has(kind)) continue;
    if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0) continue;
    ids.add(id);
    nodes.push({ id, label, kind: kind as MapNodeKind, depth });
  }

  const links: MindmapGraph["links"] = [];
  for (const entry of graph.links) {
    const link = record(entry);
    if (!link) continue;
    const { source, target } = link;
    if (typeof source !== "string" || typeof target !== "string") continue;
    if (!ids.has(source) || !ids.has(target) || source === target) continue;
    links.push({ source, target });
  }

  return { nodes, links };
}

/** A link as the dialog lists it (GET /api/mindmap-shares). */
export type MindmapShareListItem = {
  id: string;
  /** The public link, or null when this deployment cannot make one (not https). */
  url: string | null;
  created_at: string;
  /**
   * When the link stops working (DOQ-54): 24 hours after its hackathon's
   * grades are released. Null until qdit says they are.
   */
  expires_at: string | null;
};

export type MindmapShareListResponse =
  | { ok: true; shares: MindmapShareListItem[] }
  | { ok: false; code: string; message: string };

export const MINDMAP_SHARE_COPY = {
  /** Before Send, in the dialog. */
  warning:
    "Send also makes a read-only link to this mindmap. Anyone with the link can see its node labels (note titles, headings and concepts), but never the text of your notes or nodes you hid. It stops working 24 hours after the hackathon's grades are released. Revoke it here at any time.",
  /** After no answer from qdit, which may have the snapshot: its link stays live (DOQ-54). */
  keptAfterNoAnswer: "This send's mindmap link stays live; it is listed below. Revoke it if qdit doesn't have this snapshot.",
  /** An earlier link whose hackathon has not released its grades yet (DOQ-54). */
  expiresUnknown: "Expires 24 h after grades are released",
  /** When the share could not be stored and the snapshot went without a link. */
  noLink: "No live mindmap link was made this time: qdit only has the images for this send.",
  copied: "Link copied",
  copyFailed: "Couldn't copy the link. Select it and copy it by hand.",
  revoked: "Link revoked",
  revokeFailed: "Couldn't revoke the link. Try again.",
  listFailed: "Earlier links couldn't be loaded.",
  forbidden: "Only an admin or owner of this workspace can manage its mindmap links",
  notFound: "That link is already revoked, or isn't this workspace's",
} as const;
