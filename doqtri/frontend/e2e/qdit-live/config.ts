/**
 * Where the qdit-live suite points and the guards that keep it there (DOQ-20).
 *
 * The suite runs deployed doqtri staging against deployed qdit staging.
 * Nothing here is a secret; the
 * secrets come from `.env.qdit-live` (gitignored, see README.md beside this
 * file). No production host or project ref is named here as an allowed value:
 * the allow-lists are the staging hosts, and anything else fails closed.
 */

/** doqtri staging. Override with E2E_LIVE_DOQTRI_URL for a preview of the same branch. */
export const LIVE_DOQTRI_URL = (process.env.E2E_LIVE_DOQTRI_URL ?? "https://staging.doqtri.xyz").replace(/\/$/, "");

/** qdit staging's site: where its login, consent and settings pages live. */
export const LIVE_QDIT_URL = (process.env.E2E_LIVE_QDIT_URL ?? "https://staging.qdit.app").replace(/\/$/, "");

/** qdit's API base as doqtri staging uses it (CONTRACT.md section 1: includes /api/v1). */
export const LIVE_QDIT_API_BASE = `${LIVE_QDIT_URL}/api/v1`;

/** Hosts this suite will talk to. Anything else, production included, stops the run. */
const ALLOWED_DOQTRI_HOSTS = ["staging.doqtri.xyz", ...extraHosts("E2E_LIVE_EXTRA_DOQTRI_HOSTS")];
const ALLOWED_QDIT_HOSTS = ["staging.qdit.app", ...extraHosts("E2E_LIVE_EXTRA_QDIT_HOSTS")];

/** Never staging, whatever the extra lists say. */
const PRODUCTION_HOSTS = ["doqtri.xyz", "www.doqtri.xyz", "qdit.app", "www.qdit.app"];

function extraHosts(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function hostOf(url: string, label: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`${label} is not a URL: "${url}".`);
  }
}

function assertStagingHost(url: string, allowed: string[], label: string): void {
  const host = hostOf(url, label);
  if (PRODUCTION_HOSTS.includes(host)) {
    throw new Error(`Refusing to run: ${label} is the production host "${host}". qdit-live runs on staging only.`);
  }
  if (!allowed.includes(host)) {
    throw new Error(
      `Refusing to run: ${label} host "${host}" is not an allowed staging host (${allowed.join(", ")}). ` +
        "Add a preview host with E2E_LIVE_EXTRA_DOQTRI_HOSTS / E2E_LIVE_EXTRA_QDIT_HOSTS if you mean it.",
    );
  }
}

/** Both ends of the pair are staging. Called by the config and again by the spec. */
export function assertLiveTargets(): void {
  assertStagingHost(LIVE_DOQTRI_URL, ALLOWED_DOQTRI_HOSTS, "E2E_LIVE_DOQTRI_URL");
  assertStagingHost(LIVE_QDIT_URL, ALLOWED_QDIT_HOSTS, "E2E_LIVE_QDIT_URL");
}

/** A page or redirect landed on qdit staging, not on qdit production or anywhere else. */
export function assertOnQditStaging(url: string): void {
  assertStagingHost(url, ALLOWED_QDIT_HOSTS, "the qdit page doqtri sent the browser to");
}

/** doqtri's session cookies are set for this host. */
export const LIVE_DOQTRI_HOST = new URL(LIVE_DOQTRI_URL).hostname;

/** A required variable from `.env.qdit-live`, or a message naming it. */
export function liveEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is missing. Set it in doqtri/frontend/.env.qdit-live (see e2e/qdit-live/README.md).`);
  }
  return value;
}
