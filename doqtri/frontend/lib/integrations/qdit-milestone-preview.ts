import {
  QditError,
  QditNotConnectedError,
  type QditClient,
} from "@/lib/integrations/qdit-client";
import type { ConnectionStore } from "@/lib/integrations/connection-store";
import { toMilestonePreview, type MilestonePreview } from "@/lib/integrations/qdit-milestone-card";

/**
 * The milestone card's data, as one doqtri user (WP-2.6; server-only).
 *
 * GET /api/v1/milestones/{id} is the card's source (CONTRACT.md section 8),
 * read with the user's own qdit token, never a shared one, so qdit's RLS and
 * project roles decide what the user sees (D-03, D-23).
 *
 * Each card costs qdit one request, and qdit allows about 60 a minute per
 * user (section 6), so answers are kept for a short while: a loaded
 * milestone and a no-access answer for CACHE_TTL_MS, per doqtri user, per
 * qdit account (the connection's `subject`), so reconnecting as someone else
 * never shows the previous account's milestones. Concurrent reads of one
 * key share one request. Nothing else is kept: not-connected, rate limits
 * and outages are asked again next time. The cache is per server instance
 * and best effort; a title renamed through the heading shows in the card
 * within CACHE_TTL_MS.
 */

export const CACHE_TTL_MS = 30_000;
const MAX_ENTRIES = 500;

export type PreviewOutcome = { kind: "loaded"; milestone: MilestonePreview } | { kind: "no_access" };

type Entry = { at: number; value: Promise<PreviewOutcome> };

export type PreviewCache = {
  get(key: string, load: () => Promise<PreviewOutcome>): Promise<PreviewOutcome>;
  clear(): void;
};

export function createPreviewCache(
  options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): PreviewCache {
  const ttl = options.ttlMs ?? CACHE_TTL_MS;
  const max = options.maxEntries ?? MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  return {
    get(key, load) {
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttl) return hit.value;
      if (hit) entries.delete(key);

      const value = load();
      entries.set(key, { at: now(), value });
      // A failure is not kept: the next card asks again.
      value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key);
      });
      // Oldest first (Map keeps insertion order).
      while (entries.size > max) entries.delete(entries.keys().next().value as string);
      return value;
    },
    clear: () => entries.clear(),
  };
}

/** This server instance's cache. */
export const milestonePreviewCache = createPreviewCache();

/**
 * The card's outcome for `milestoneId`, or a QditError for anything other
 * than loaded or no access (QditNotConnectedError when the user has no
 * usable connection: then qdit is not asked at all).
 */
export async function loadMilestonePreview(deps: {
  userId: string;
  milestoneId: string;
  store: ConnectionStore;
  client: () => QditClient;
  cache?: PreviewCache;
}): Promise<PreviewOutcome> {
  const conn = await deps.store.load(deps.userId);
  if (!conn || conn.status !== "connected" || !conn.accessToken) {
    throw new QditNotConnectedError(!conn ? "none" : conn.status === "connected" ? "needs_reconnect" : conn.status);
  }

  const key = `${deps.userId}|${conn.subject}|${deps.milestoneId}`;
  return (deps.cache ?? milestonePreviewCache).get(key, async () => {
    try {
      const milestone = toMilestonePreview(await deps.client().getMilestone(deps.milestoneId));
      if (!milestone) throw new QditError("bad_response", "qdit sent a milestone Doqtri could not read.");
      return { kind: "loaded", milestone };
    } catch (error) {
      // 404 never says whether the milestone exists (section 6), and 403 is
      // a milestone the user can see but not this way: the card says the
      // same for both.
      if (error instanceof QditError && (error.kind === "not_found" || error.kind === "forbidden")) {
        return { kind: "no_access" };
      }
      throw error;
    }
  });
}
