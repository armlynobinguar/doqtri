import { createHmac, randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import { QDIT_STUB_ISSUER, QDIT_STUB_ORIGIN, QDIT_STUB_WEBHOOK_SECRET } from "./config";

/**
 * The specs' handle on the stand-in qdit (server.mts): who exists there, who
 * holds which project role, what the next consent screen answers, and the
 * qdit-side events doqtri has to cope with (a deleted milestone, a deleted
 * project, a revoked grant).
 */

export type QditRole = "viewer" | "member" | "admin" | "owner";

async function control<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${QDIT_STUB_ORIGIN}/__stub${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`qdit stub ${method} ${path}: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export type StubMilestone = {
  id: string;
  title: string;
  status: string;
  link: { id: string; doc_id: string; node_id: string; node_label: string } | null;
};

export const stub = {
  reset: () => control("POST", "/reset"),

  /** A qdit account. Returns its id (qdit's `sub`). */
  async user(username: string): Promise<string> {
    const id = randomUUID();
    await control("POST", "/users", { id, username, display_name: username, wallet_address: null });
    return id;
  },

  /** A qdit project with `members` (qdit user id -> role). Returns its id. */
  async project(name: string, members: Record<string, QditRole>): Promise<string> {
    const id = randomUUID();
    await control("POST", "/projects", { id, name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id.slice(0, 6)}`, members });
    return id;
  },

  /** Changes a qdit user's role in a project; null takes them out of it. */
  setRole: (projectId: string, user: string, role: QditRole | null) =>
    control("POST", `/projects/${projectId}/role`, { user, role }),

  /** The next /oauth/authorize is approved as this qdit user. */
  consentAs: (user: string) => control("POST", "/authorize", { as: user }),
  /** The next /oauth/authorize is declined. */
  denyConsent: () => control("POST", "/authorize", { deny: true }),

  /** The user revokes doqtri under Authorized apps in qdit (D-59): every token stops working. */
  revoke: (user: string) => control("POST", "/revoke", { user }),

  /** A qdit admin deletes the project; its doc links and milestones go with it. */
  deleteProject: (projectId: string) => control("POST", `/projects/${projectId}/delete`),
  /** A qdit admin deletes a milestone doqtri still links. */
  deleteMilestone: (milestoneId: string) => control("POST", `/milestones/${milestoneId}/delete`),
  /** qdit links a doc to a project without doqtri, as an earlier link or another app would. */
  linkDocElsewhere: (projectId: string, docId: string) => control("POST", "/doc-links", { project_id: projectId, doc_id: docId }),
  setMilestoneStatus: (milestoneId: string, status: "proposed" | "submitted" | "approved" | "rejected") =>
    control("POST", `/milestones/${milestoneId}/status`, { status }),

  /** A hackathon in qdit; GET /hackathons lists it while it is not hidden, not `test-` and not closed. */
  hackathon: (h: { slug: string; name: string; opens_at: string; closes_at: string; hidden?: boolean }) =>
    control("POST", "/hackathons", h),
  /** false plays a qdit older than v1.3.0, where GET /hackathons is 404; reset() turns it back on. */
  setHackathonList: (enabled: boolean) => control("POST", "/hackathon-list", { enabled }),

  milestone: (id: string) => control<StubMilestone>("GET", `/milestones/${id}`),
  async milestoneOrNull(id: string): Promise<StubMilestone | null> {
    try {
      return await stub.milestone(id);
    } catch {
      return null;
    }
  },
  async docLink(docId: string): Promise<{ project_id: string } | null> {
    try {
      return await control<{ project_id: string }>("GET", `/doc-links/${docId}`);
    } catch {
      return null;
    }
  },
  log: () => control<{ method: string; path: string; user: string | null; status: number; body: unknown }[]>("GET", "/log"),
};

/**
 * Fails fast when the doqtri dev server is not wired to this stub: a dev
 * server started by hand (reuseExistingServer) may point at a real qdit, and
 * these specs must never write there. Connect's redirect names the issuer.
 */
export async function expectAppUsesStub(request: APIRequestContext): Promise<void> {
  const res = await request.get("/api/integrations/qdit/connect", { maxRedirects: 0 });
  const location = res.headers()["location"] ?? "";
  expect(
    location.startsWith(`${QDIT_STUB_ISSUER}/oauth/authorize`),
    `The dev server on :3000 is not using the qdit stub (connect redirects to "${location}", status ${res.status()}). ` +
      "Stop it and let Playwright start its own (it sets the QDIT_* variables).",
  ).toBeTruthy();
}

/** A webhook body and headers signed the way qdit signs them (CONTRACT.md section 9). */
export function signedWebhook(
  event: { project_id: string; milestone_id: string; status: string; id?: string; event?: string },
  opts: { secret?: string; timestamp?: number } = {},
): { body: string; headers: Record<string, string>; id: string } {
  const id = event.id ?? randomUUID();
  const body = JSON.stringify({
    id,
    event: event.event ?? "milestone.status_changed",
    project_id: event.project_id,
    milestone_id: event.milestone_id,
    status: event.status,
    occurred_at: new Date().toISOString(),
  });
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", opts.secret ?? QDIT_STUB_WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return {
    id,
    body,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Qdit-Timestamp": timestamp,
      "X-Qdit-Signature": `sha256=${signature}`,
    },
  };
}
