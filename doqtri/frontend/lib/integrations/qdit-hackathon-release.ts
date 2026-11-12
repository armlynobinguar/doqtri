import type { SupabaseClient } from "@supabase/supabase-js";
import { HACKATHON_SLUG } from "@/lib/integrations/qdit-hackathon";

/**
 * qdit's `hackathon.released` webhook event (WP-4.7, DOQ-54, QDIT-67;
 * contract v1.5.0, section 9; server-only). qdit sends it once, when a
 * hackathon admin releases the grades, with the same signature, outbox and
 * retries as `milestone.status_changed`:
 *
 *   {"id": "<event uuid>", "event": "hackathon.released",
 *    "hackathon_slug": "<slug>", "released_at": "<ISO 8601>", "occurred_at": "<ISO 8601>"}
 *
 * doqtri then makes every mindmap link sent to that hackathon expire at
 * released_at + 24 hours (record_qdit_hackathon_release(), backend migration
 * 20261112200000). The signature is checked and the body parsed by
 * handleQditWebhook (qdit-status-sync.ts); this file has the event's shape
 * and the store.
 */

export const QDIT_HACKATHON_RELEASED_EVENT = "hackathon.released";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HackathonReleasedEvent = {
  id: string;
  event: typeof QDIT_HACKATHON_RELEASED_EVENT;
  hackathonSlug: string;
  releasedAt: string;
  occurredAt: string;
};

const isTimestamp = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

/** The event in `body` (already JSON, already `event: "hackathon.released"`), or null when a field is missing or malformed. */
export function parseHackathonReleased(body: Record<string, unknown>): HackathonReleasedEvent | null {
  const id = typeof body.id === "string" && UUID.test(body.id) ? body.id.toLowerCase() : null;
  const slug = typeof body.hackathon_slug === "string" && HACKATHON_SLUG.test(body.hackathon_slug) ? body.hackathon_slug : null;
  if (!id || !slug || !isTimestamp(body.released_at) || !isTimestamp(body.occurred_at)) return null;
  return {
    id,
    event: QDIT_HACKATHON_RELEASED_EVENT,
    hackathonSlug: slug,
    releasedAt: new Date(body.released_at).toISOString(),
    occurredAt: new Date(body.occurred_at).toISOString(),
  };
}

export type HackathonReleaseOutcome = {
  /** `duplicate`: this event id was already acted on, and nothing changed. */
  outcome: "applied" | "duplicate";
  /** The hackathon's links' expiry as it now stands. */
  expiresAt: string | null;
  linksUpdated: number;
};

export type HackathonReleaseStore = {
  record(event: HackathonReleasedEvent): Promise<HackathonReleaseOutcome>;
};

/** The store over the service-role client. Throws on any database error, which the webhook answers 503 (qdit retries). */
export function supabaseHackathonReleaseStore(admin: SupabaseClient): HackathonReleaseStore {
  return {
    async record(event) {
      const { data, error } = await admin.rpc("record_qdit_hackathon_release", {
        p_id: event.id,
        p_hackathon_slug: event.hackathonSlug,
        p_released_at: event.releasedAt,
        p_occurred_at: event.occurredAt,
      });
      if (error) throw new Error(`Could not record the hackathon release: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as
        | { outcome: string; link_expires_at: string | null; links_updated: number }
        | null
        | undefined;
      if (!row || (row.outcome !== "applied" && row.outcome !== "duplicate")) {
        throw new Error("Unexpected hackathon release result");
      }
      return { outcome: row.outcome, expiresAt: row.link_expires_at, linksUpdated: row.links_updated };
    },
  };
}
