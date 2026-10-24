/**
 * What the profile's Connected apps shows (WP-2.3). Shared by the qdit
 * routes, which send the browser back with an outcome, and the profile,
 * which turns it into a sentence. Safe for the browser: no secrets here.
 *
 * The routes only ever send one of these fixed codes back, never qdit's own
 * error text, so nothing from the provider is echoed into the page.
 */

export const CONNECTED_APPS_TAB = "apps";

export type QditOutcome = "connected" | "denied" | "error";

export type QditErrorReason =
  /** The integration is on but this deployment has no qdit configured. */
  | "not_configured"
  /** No state cookie, or one that does not open: cookies blocked, or another browser. */
  | "state"
  /** The connect took longer than the state allows. */
  | "expired"
  /** The flow was started by another doqtri account in this browser. */
  | "other_user"
  /** qdit refused to exchange the code. */
  | "exchange"
  /** qdit's account check failed, or the token is not doqtri's. */
  | "account"
  /** qdit could not be reached. */
  | "unavailable"
  /** qdit reported an error other than a denial. */
  | "provider";

const REASONS: Record<QditErrorReason, string> = {
  not_configured: "qdit isn't set up on this deployment yet.",
  state: "The connection couldn't be verified. Start again from this page, in the same browser.",
  expired: "The connection took too long. Start again.",
  other_user: "That connection was started from another Doqtri account. Start again while signed in as yourself.",
  exchange: "qdit didn't accept the sign-in. Start again.",
  account: "qdit's account check failed. Start again, and tell us if it keeps happening.",
  unavailable: "qdit couldn't be reached. Try again in a moment.",
  provider: "qdit reported a problem with the request. Start again.",
};

/** The profile URL the routes send the browser back to. */
export function connectedAppsPath(outcome?: QditOutcome, reason?: QditErrorReason): string {
  const query = new URLSearchParams({ tab: CONNECTED_APPS_TAB });
  if (outcome) query.set("qdit", outcome);
  if (outcome === "error" && reason) query.set("reason", reason);
  return `/vault/profile?${query}`;
}

/** The sentence for an outcome in the URL, or null for none or an unknown one. */
export function describeQditOutcome(
  outcome: string | null,
  reason: string | null,
): { tone: "success" | "warning"; text: string } | null {
  if (outcome === "connected") return { tone: "success", text: "qdit is connected." };
  if (outcome === "denied") return { tone: "warning", text: "You didn't allow Doqtri in qdit, so nothing was connected." };
  if (outcome !== "error") return null;
  const text =
    reason && Object.prototype.hasOwnProperty.call(REASONS, reason) ? REASONS[reason as QditErrorReason] : REASONS.provider;
  return { tone: "warning", text };
}

/** The connection as the profile sees it: from my_integration_connections(), no tokens. */
export type QditConnectionSummary = {
  status: "connected" | "needs_reconnect" | "revoked";
  /** qdit's username or display name, if qdit had one. */
  accountLabel: string | null;
  subject: string;
  connectedAt: string;
};
