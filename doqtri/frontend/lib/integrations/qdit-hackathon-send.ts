import { roleAtLeast, type WorkspaceRole } from "@/lib/workspace-roles";

/**
 * "Send to qdit hackathon" (WP-4.7, D-117): what the global mindmap's dialog
 * and POST /api/integrations/qdit/hackathon share. Pure and safe for the
 * browser: the snapshot itself is built on the server
 * (qdit-hackathon.ts), never from what the browser sends.
 */

/** A qdit hackathon slug (CONTRACT.md section 8, `hackathon_slug`). */
export const HACKATHON_SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;

const HACKATHON_PATH = /^\/hackathons\/([^/]+)\/?(?:\/.*)?$/;

const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, "");

/**
 * The hackathon slug in what the user pasted: the slug itself, or a qdit
 * link like `https://qdit.app/hackathons/<slug>` (a deeper path, a query or a
 * fragment are ignored). A link must be on qdit's host (`www.` or not), so
 * with `qditOrigin` unknown only a bare slug is taken. Null when there is no
 * valid slug in it.
 */
export function parseHackathonInput(input: unknown, qditOrigin: string | null): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (HACKATHON_SLUG_PATTERN.test(value)) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!qditOrigin) return null;
  let origin: URL;
  try {
    origin = new URL(qditOrigin);
  } catch {
    return null;
  }
  if (bareHost(url.host) !== bareHost(origin.host)) return null;
  const slug = HACKATHON_PATH.exec(url.pathname)?.[1] ?? null;
  return slug && HACKATHON_SLUG_PATTERN.test(slug) ? slug : null;
}

/** The hackathon's page in qdit, or null when the qdit origin is unknown. */
export function hackathonUrl(qditOrigin: string | null, slug: string): string | null {
  return qditOrigin ? `${qditOrigin.replace(/\/+$/, "")}/hackathons/${slug}` : null;
}

/** Workspace admins and owners send (D-10), and only with qdit connected. */
export function canSendToHackathon(role: WorkspaceRole | null | undefined, qditConnected: boolean): boolean {
  return qditConnected && roleAtLeast(role, "admin");
}

/** qdit's view of the project's entry against the snapshot just sent. */
export type HackathonSubmissionState = "none" | "submitted_older" | "current";

export type HackathonSendCode =
  | "NOT_FOUND"
  | "NOT_SIGNED_IN"
  | "FORBIDDEN"
  | "BAD_REQUEST"
  | "BAD_HACKATHON_LINK"
  | "WORKSPACE_CHANGED"
  | "QDIT_NOT_CONFIGURED"
  | "QDIT_NOT_CONNECTED"
  | "TOO_LARGE"
  | "HACKATHON_CLOSED"
  | "HACKATHON_NOT_OPEN"
  | "SNAPSHOT_LIMIT"
  | "SNAPSHOT_CONFLICT"
  | "QDIT_FORBIDDEN"
  | "QDIT_NOT_FOUND"
  | "QDIT_REFUSED"
  | "QDIT_RATE_LIMITED"
  /** No answer from qdit (network or timeout): the snapshot may have landed. */
  | "QDIT_UNCERTAIN"
  | "QDIT_UNAVAILABLE"
  | "FAILED";

export type HackathonSendSuccess = {
  ok: true;
  note_count: number;
  submission_state: HackathonSubmissionState;
  /** The hackathon's page in qdit, where the team submits. */
  qdit_url: string | null;
  /** What was left out or shortened to fit, in plain words. */
  warnings: string[];
};

export type HackathonSendFailure = {
  ok: false;
  code: HackathonSendCode;
  message: string;
  /** With QDIT_UNCERTAIN: the hackathon's page, to check the entry before sending again. */
  qdit_url?: string | null;
};

export type HackathonSendResponse = HackathonSendSuccess | HackathonSendFailure;

/** The dialog's copy, in one place so the route tests pin the same words. */
export const HACKATHON_SEND_COPY = {
  closed: "Submissions are closed",
  notOpen: "This hackathon hasn't opened yet",
  snapshotLimit: "This project has reached the snapshot limit for this hackathon",
  qditForbidden:
    "qdit refused this: you need to be an admin of that qdit project. If you are, ask the organisers to check the doqtri connection.",
  notFound: "Hackathon or project not found",
  conflict: "Something went wrong sending the snapshot. Press Send to try again.",
  tooLarge: (field: string) => `Too much to send: remove or shorten notes (${field})`,
  /** Only while qdit has no hackathon list (D-122): the link field's check. */
  badLink: "Paste the hackathon's link from qdit, ending in /hackathons/<name>",
  pickHackathon: "Pick an open hackathon",
  hackathonsLoading: "Loading hackathons from qdit…",
  hackathonsFailed: "qdit's hackathons couldn't be loaded. Close this and try again.",
  noOpenHackathons: "No open hackathons in qdit right now.",
  forbidden: "Only an admin or owner of this workspace can send it to a hackathon",
  workspaceChanged: "You switched workspace in another tab. Reload this page and try again.",
  pickProject: "Pick a qdit project",
  rateLimited: "qdit is busy. Try again in a moment.",
  unavailable: "qdit couldn't be reached. Try again.",
  uncertain: "qdit may have received this. Check your entry in qdit before sending again.",
  failed: "Something went wrong building the snapshot. Try again.",
  notConfigured: "qdit isn't set up on this deployment.",
  /** After a send: what the team does next. */
  next: {
    none: "Now submit (or resubmit) in qdit",
    submitted_older: "Resubmit in qdit to include this",
    current: "Your submission in qdit already includes this",
  } satisfies Record<HackathonSubmissionState, string>,
  visibility:
    "Every member of the qdit project you pick, and the hackathon's staff, can read what you send. qdit keeps its copy until 90 days after the hackathon closes, even if you change or delete the notes here.",
} as const;
