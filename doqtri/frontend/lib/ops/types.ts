/**
 * The ops dashboard's vocabulary (DOQ-14, WP-4.3). Every check answers one
 * OpsResult; the dashboard lists them worst first, per section.
 *
 *   ok       within its threshold
 *   warn     needs a look soon
 *   crit     broken now, or about to run out
 *   off      not used by this deployment (unset key, feature off, other network)
 *   unknown  the check failed or did not answer in time
 */

export type OpsStatus = "ok" | "warn" | "crit" | "off" | "unknown";

export type OpsSection = "spendable" | "statuses" | "health";

export type OpsResult = {
  status: OpsStatus;
  /** The reading, formatted for display ("1,240 XLM", "3 pending"). */
  value: string;
  /** What ok means, in words ("warn < 2,000 · crit < 1,000"). */
  threshold?: string;
  /** One line of context. Never a secret, a keyed URL or user data. */
  detail?: string;
};

export type OpsCheck = OpsResult & { id: string; section: OpsSection; label: string };

export type OpsCheckDef = {
  id: string;
  section: OpsSection;
  label: string;
  run: () => Promise<OpsResult>;
};

export type OpsReport = {
  generatedAt: string;
  /** VERCEL_ENV (production, preview) or NODE_ENV locally. */
  environment: string;
  network: string;
  /** The deployed commit, first 8 characters, when Vercel says. */
  commit: string | null;
  checks: OpsCheck[];
};
