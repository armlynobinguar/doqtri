/**
 * What the profile's Connected apps shows (WP-2.3). Shared by the qdit
 * routes, which send the browser back with an outcome, and the profile,
 * which turns it into a sentence. Safe for the browser: no secrets here.
 *
 * The routes only ever send one of these fixed codes back, never qdit's own
 * error text, so nothing from the provider is echoed into the page.
 */

export const CONNECTED_APPS_TAB = "apps";

/** `switched`: connected, to another qdit account than before (D-66). */
export type QditOutcome = "connected" | "switched" | "denied" | "error";

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

/** How the profile names a qdit account: its label, else its id. */
export function qditAccountName(account: { accountLabel: string | null; subject: string }): string {
  return account.accountLabel ?? account.subject;
}

/**
 * The sentence for an outcome in the URL, or null for none or an unknown
 * one. Names come from `connection` (what the database says), never from
 * the URL, so a crafted link cannot put words in the notice: a `switched`
 * with no replaced account on record reads as a plain connect.
 */
export function describeQditOutcome(
  outcome: string | null,
  reason: string | null,
  connection: QditConnectionSummary | null = null,
): { tone: "success" | "warning"; text: string } | null {
  if (outcome === "switched" && connection?.status === "connected" && connection.previous) {
    return {
      tone: "success",
      text: `Now connected as ${qditAccountName(connection)} (was ${qditAccountName(connection.previous)}).`,
    };
  }
  if (outcome === "connected" || outcome === "switched") return { tone: "success", text: "qdit is connected." };
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
  /** The qdit account the last connect replaced, when it was another one (D-66). */
  previous: { subject: string; accountLabel: string | null } | null;
};
