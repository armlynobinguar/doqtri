import { test, expect, type Page } from "@playwright/test";
import { parseTokenKey, openSecret } from "../../lib/integrations/token-crypto";
import { assertNotProduction } from "../guard";
import { deleteNote, seedNote, serviceRest, testUserId, uniqueTitle } from "../helpers";
import { createTeamWorkspace, deleteWorkspace } from "../teams";
import { LIVE_QDIT_API_BASE, LIVE_QDIT_URL, assertLiveTargets, assertOnQditStaging, liveEnv } from "./config";

/**
 * doqtri staging against the real qdit staging, over the real wire (DOQ-20;
 * WP-2.8, gate G2).
 *
 * The stub suite (../qdit-integration.spec.ts) proves doqtri follows
 * CONTRACT.md. This one proves the deployed pair still talk to each other:
 * real OAuth, real qdit API, real D-59 revocation. It is a smoke pass, run in
 * order, not a copy of the stub suite's edge cases.
 *
 * Out of scope, by decision on DOQ-20 (option c): approving a milestone. qdit
 * approves only on chain, signed by the project owner's wallet, and the
 * webhook to doqtri fires from that anchor. Approval and the webhook stay
 * G2's manual step.
 *
 * Needs, in .env.qdit-live (see README.md):
 * - QDIT_LIVE_EMAIL / QDIT_LIVE_PASSWORD: a qdit staging account with a
 *   recovery email and password;
 * - QDIT_LIVE_PROJECT_ID: a qdit staging project that account is an admin of;
 * - INTEGRATION_TOKEN_KEY: doqtri staging's key, so the suite can read the
 *   token doqtri holds and call qdit with it directly;
 * - the doqtri staging branch's Supabase URL, anon and service role keys, and
 *   its ref in E2E_ALLOWED_SUPABASE_REFS.
 */

test.describe.configure({ mode: "serial" });

/** Two headings: "# Title" is h0, then h1 and h2 (lib/mindmap.ts). */
const PLAN = (title: string) => `# ${title}\n\n## Build the escrow\n\nDetails.\n\n## Ship it\n\nLater.\n`;
const H_BUILD = "h1";

let aId: string;
let team: string;
let projectId: string;
let note: { id: string; title: string } | null = null;
let milestoneId: string | null = null;

test.beforeAll(async () => {
  assertLiveTargets();
  assertNotProduction();
  projectId = liveEnv("QDIT_LIVE_PROJECT_ID");
  liveEnv("QDIT_LIVE_EMAIL");
  liveEnv("QDIT_LIVE_PASSWORD");
  liveEnv("INTEGRATION_TOKEN_KEY");

  aId = await testUserId();
  // A connection left by an interrupted run would make the connect a "switched" one.
  await dropConnection();
  team = await createTeamWorkspace(uniqueTitle("E2E qdit-live Team"), aId);
  const title = uniqueTitle("Live Escrow Plan");
  note = { id: await seedNote(title, PLAN(title), undefined, { workspaceId: team, userId: aId }), title };
});

test.afterAll(async () => {
  if (note) await deleteNote(note.id);
  if (team) await deleteWorkspace(team);
  if (milestoneId) {
    await serviceRest(`qdit_milestone_states?milestone_id=eq.${milestoneId}`, { method: "DELETE" });
  }
  await dropConnection();
});

async function dropConnection() {
  await serviceRest(`integration_connections?user_id=eq.${aId}&provider=eq.qdit`, { method: "DELETE" });
}

/** The access token doqtri holds for this user, opened with staging's key. */
async function heldAccessToken(): Promise<string> {
  const [row] = await serviceRest<{ access_token_ciphertext: string | null }[]>(
    `integration_connections?user_id=eq.${aId}&provider=eq.qdit&select=access_token_ciphertext`,
  );
  const opened = openSecret(row?.access_token_ciphertext, parseTokenKey(liveEnv("INTEGRATION_TOKEN_KEY")), `qdit:access:${aId}`);
  expect(opened, "doqtri holds no qdit token this suite can open; is INTEGRATION_TOKEN_KEY staging's?").not.toBeNull();
  return opened!.plaintext;
}

/** qdit's API, called directly with the token doqtri holds. */
async function qdit(page: Page, token: string, method: string, path: string, data?: unknown) {
  return page.request.fetch(`${LIVE_QDIT_API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    data,
  });
}

/**
 * qdit's recovery sign-in (email and password), when qdit asked for it, then
 * waits until `landed`. Each test has a fresh browser context, so every visit
 * to qdit starts signed out.
 */
async function signInToQditIfAsked(page: Page, landed: (url: URL) => boolean) {
  if (new URL(page.url()).pathname !== "/login") return;
  await page.getByLabel("Email").fill(liveEnv("QDIT_LIVE_EMAIL"));
  await page.getByLabel("Password").fill(liveEnv("QDIT_LIVE_PASSWORD"));
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(landed, { timeout: 30_000 });
}

function card(page: Page) {
  return page.getByTestId("qdit-links").getByTestId("qdit-milestone-card");
}

// ---------------------------------------------------------------------------

test("connect: doqtri -> qdit sign-in and consent -> doqtri, and qdit's /me answers", async ({ page }) => {
  // Look before following: the connect must send the browser to qdit's
  // OAuth server, and that server must hand it to qdit staging.
  const start = await page.request.get("/api/integrations/qdit/connect", { maxRedirects: 0 });
  expect(start.status(), "connect should redirect to qdit's authorize endpoint").toBe(303);
  expect(start.headers()["location"] ?? "").toMatch(/\/auth\/v1\/oauth\/authorize\?/);

  await page.goto("/api/integrations/qdit/connect");
  // No qdit session yet: its consent page sends us to its login, carrying `next`.
  await page.waitForURL((url) => url.pathname === "/login" || url.pathname === "/oauth/consent");
  assertOnQditStaging(page.url());

  // qdit shows its consent screen the first time. Once the account has
  // consented to Doqtri (an earlier run that stopped before revoking), Supabase
  // skips it and sends the browser straight back to doqtri.
  const consentOrBack = (url: URL) => url.pathname === "/oauth/consent" || url.pathname === "/vault/profile";
  await signInToQditIfAsked(page, consentOrBack);
  // The consent page loads either way and forwards at once when consent
  // exists, so wait for whichever shows: its Allow button, or doqtri again.
  const allow = page.getByRole("button", { name: /^Allow / });
  const backInDoqtri = /\/vault\/profile/;
  await Promise.race([allow.waitFor({ state: "visible", timeout: 30_000 }), page.waitForURL(backInDoqtri, { timeout: 30_000 })]);
  if (!backInDoqtri.test(page.url())) {
    assertOnQditStaging(page.url());
    await allow.click();
  }
  await page.waitForURL(backInDoqtri, { timeout: 30_000 });
  await expect(page.getByTestId("qdit-outcome")).toHaveText("qdit is connected.");
  await expect(page.getByTestId("qdit-status")).toHaveText("Connected");

  // The token doqtri stored works against qdit itself.
  const me = await qdit(page, await heldAccessToken(), "GET", "/me");
  expect(me.status(), await me.text()).toBe(200);
  // CONTRACT.md section 8: { user: { id, ... }, client_id }.
  const { data } = (await me.json()) as { data: { user: { id: string }; client_id: string } };
  expect(data.user.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(data.client_id).toMatch(/^[0-9a-f-]{36}$/);
});

test("projects: doqtri lists the qdit project, and a note links to it", async ({ page }) => {
  const listed = await page.request.get("/api/integrations/qdit/projects");
  expect(listed.status(), await listed.text()).toBe(200);
  const projects = ((await listed.json()) as { projects: { id: string; name: string; can_link: boolean }[] }).projects;
  const project = projects.find((p) => p.id === projectId);
  expect(project, `QDIT_LIVE_PROJECT_ID is not among the projects qdit staging returned (${projects.length})`).toBeTruthy();
  expect(project!.can_link, "the qdit test account must be an admin of QDIT_LIVE_PROJECT_ID").toBe(true);

  await page.goto(`/vault/${note!.id}`);
  const panel = page.getByTestId("qdit-links");
  await panel.getByRole("button", { name: "Link to a qdit project" }).click();
  await panel.getByLabel("qdit project").click();
  await page.getByRole("option", { name: project!.name }).click();
  await panel.getByRole("button", { name: "Link", exact: true }).click();
  await expect(page.getByText("Note linked to qdit")).toBeVisible();
  await expect(panel).toContainText(`Project ${project!.name}`);

  const rows = await serviceRest<{ project_id: string }[]>(`doc_project_links?document_id=eq.${note!.id}&select=project_id`);
  expect(rows).toEqual([{ project_id: projectId }]);
});

test("milestone: one made from a heading exists in qdit, linked back to the note", async ({ page }) => {
  await page.goto(`/vault/${note!.id}`);
  const panel = page.getByTestId("qdit-links");
  await panel.getByLabel("Heading to link").click();
  await page.getByRole("option", { name: "Build the escrow" }).click();
  await panel.getByRole("button", { name: "Create milestone" }).click();
  await expect(page.getByText("Milestone created in qdit")).toBeVisible({ timeout: 30_000 });

  await card(page).scrollIntoViewIfNeeded();
  await expect(card(page)).toHaveAttribute("data-state", "loaded", { timeout: 20_000 });
  await expect(card(page)).toContainText("Proposed");

  const [row] = await serviceRest<{ qdit_milestone_id: string }[]>(
    `node_links?document_id=eq.${note!.id}&provider=eq.qdit&node_id=eq.${H_BUILD}&select=qdit_milestone_id`,
  );
  expect(row?.qdit_milestone_id).toBeTruthy();
  milestoneId = row.qdit_milestone_id;

  const read = await qdit(page, await heldAccessToken(), "GET", `/milestones/${milestoneId}`);
  expect(read.status(), await read.text()).toBe(200);
  // CONTRACT.md section 7: the Milestone carries `project: { id, name, slug }`.
  expect((await read.json()).data).toMatchObject({
    project: { id: projectId },
    title: "Build the escrow",
    status: "proposed",
    link: { doc_id: note!.id, node_id: H_BUILD },
  });
});

test("a doqtri token cannot approve a milestone in qdit (G2)", async ({ page }) => {
  const token = await heldAccessToken();

  // PATCH /milestones/{id} takes exactly {"title"}; a status is an unknown field (section 8).
  for (const body of [{ status: "approved" }, { title: "Build the escrow", status: "approved" }]) {
    const res = await qdit(page, token, "PATCH", `/milestones/${milestoneId}`, body);
    expect(res.status(), await res.text()).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_request");
  }

  // No other v1 route approves: approval is the owner's wallet, on chain.
  for (const path of [`/milestones/${milestoneId}/approve`, `/milestones/${milestoneId}/status`]) {
    const res = await qdit(page, token, "POST", path, { status: "approved" });
    expect(res.status(), `${path}: ${await res.text()}`).toBe(404);
  }

  const after = await qdit(page, token, "GET", `/milestones/${milestoneId}`);
  expect((await after.json()).data.status).toBe("proposed");
});

test("unlink: the milestone link and the project link go, the milestone stays in qdit", async ({ page }) => {
  await page.goto(`/vault/${note!.id}`);
  const panel = page.getByTestId("qdit-links");
  await panel.getByRole("button", { name: "Unlink the milestone from “Build the escrow”" }).click();
  await expect(page.getByText("Unlinked. The milestone stays in qdit.")).toBeVisible();

  await panel.getByRole("button", { name: "Unlink project" }).click();
  await panel.getByRole("button", { name: "Unlink, and every milestone link" }).click();
  await expect(page.getByText("Note unlinked from qdit. Its milestones stay in qdit.")).toBeVisible();
  expect(await serviceRest(`doc_project_links?document_id=eq.${note!.id}&select=project_id`)).toEqual([]);

  const read = await qdit(page, await heldAccessToken(), "GET", `/milestones/${milestoneId}`);
  expect(read.status(), await read.text()).toBe(200);
  expect((await read.json()).data.link).toBeNull();
});

test("revoke in qdit cuts doqtri off at once (D-59)", async ({ page }) => {
  // Read before revoking: doqtri drops its copy once qdit refuses it.
  const token = await heldAccessToken();

  await page.goto(`${LIVE_QDIT_URL}/settings`);
  await page.waitForURL((url) => url.pathname === "/settings" || url.pathname === "/login");
  assertOnQditStaging(page.url());
  // A sign-in reached from /settings lands on qdit's dashboard, not back here.
  await signInToQditIfAsked(page, (url) => url.pathname === "/settings" || url.pathname === "/dashboard");
  if (new URL(page.url()).pathname !== "/settings") await page.goto(`${LIVE_QDIT_URL}/settings`);
  assertOnQditStaging(page.url());

  // The test account authorizes only Doqtri; the dialog title proves the right row was picked.
  await page.getByRole("button", { name: "Revoke" }).first().click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(/Disconnect Doqtri/i);
  await dialog.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText(/disconnected$/)).toBeVisible();

  const direct = await qdit(page, token, "GET", "/me");
  expect(direct.status(), "qdit kept accepting a revoked token").toBe(401);
  expect((await direct.json()).error.code).toBe("unauthorized");

  const projects = await page.request.get("/api/integrations/qdit/projects");
  expect(projects.status(), await projects.text()).toBe(409);
  expect((await projects.json()).code).toBe("QDIT_NOT_CONNECTED");

  await page.goto("/vault/profile?tab=apps");
  await expect(page.getByTestId("qdit-status")).toHaveText("Reconnect needed");
});
