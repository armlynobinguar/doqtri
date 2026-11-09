import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { assertNotProduction } from "./guard";
import { deleteNote, replaceEditorText, seedNote, serviceRest, testUserId, uniqueTitle, userIdForWallet } from "./helpers";
import { expectAppUsesStub, signedWebhook, stub } from "./qdit-stub/client";
import { createTeamWorkspace, deleteWorkspace, setMember } from "./teams";
import { e2eKeypair, signedInContext } from "./wallet-session";

/**
 * doqtri x qdit, end to end against the contract stub (DOQ-16; WP-2.3 to
 * WP-2.8, gate G2 minus the chain step).
 *
 * qdit is not ours to run, so e2e/qdit-stub/server.mts stands in for it,
 * built from docs/integration/CONTRACT.md. Its projects carry `chain: null`,
 * so qdit's milestone_proof is never read: the webhook records
 * `unregistered`, and the Verified signing step (G2's last criterion) stays
 * with the testnet gate. Creating a milestone still reads doqtri's own
 * DoqtriRegistry version over Soroban RPC (a failed read sends
 * doc_version null), so those calls wait on testnet RPC.
 *
 * Two people on each side:
 * - doqtri A (the default session) owns the team workspace; qdit "qa" is an
 *   admin of the project.
 * - doqtri B (a second wallet) joins the workspace with a role per test;
 *   qdit "qb" gets a role per test.
 */

const B = e2eKeypair("doqtri-e2e-wallet-b");

/** Two headings: "# Title" is h0, then h1 and h2 (lib/mindmap.ts). */
const PLAN = (title: string) => `# ${title}\n\n## Build the escrow\n\nDetails.\n\n## Ship it\n\nLater.\n`;
const H_BUILD = "h1";
const H_SHIP = "h2";

let aId: string;
let bId: string;
let team: string;
let qa: string;
let qb: string;
let project: string;
let projectName: string;
let bContext: BrowserContext;
const webhookIds: string[] = [];
/** Every stub project this run made, for cleaning doqtri's milestone state rows. */
const projectIds: string[] = [];

test.beforeAll(async ({ browser }) => {
  assertNotProduction();
  bContext = await signedInContext(browser, B);
  aId = await testUserId();
  bId = await userIdForWallet(B.publicKey());
  // A connection left by an interrupted run would turn the first connect
  // into a "switched" one; start both people disconnected.
  await dropConnections();
  team = await createTeamWorkspace(uniqueTitle("E2E qdit Team"), aId);

  await stub.reset();
  qa = await stub.user("qa");
  qb = await stub.user("qb");
  projectName = uniqueTitle("Payroll");
  project = await newProject(projectName, { [qa]: "admin" });
});

test.afterAll(async () => {
  await bContext?.close();
  if (team) await deleteWorkspace(team);
  await dropConnections();
  if (webhookIds.length > 0) {
    await serviceRest(`qdit_webhook_events?id=in.(${webhookIds.join(",")})`, { method: "DELETE" });
  }
  // qdit_milestone_states has no foreign key to the links, so this run's rows stay unless removed.
  if (projectIds.length > 0) {
    await serviceRest(`qdit_milestone_states?project_id=in.(${projectIds.join(",")})`, { method: "DELETE" });
  }
});

async function dropConnections() {
  for (const user of [aId, bId].filter(Boolean)) {
    await serviceRest(`integration_connections?user_id=eq.${user}&provider=eq.qdit`, { method: "DELETE" });
  }
}

test.beforeEach(async ({ page }) => {
  await expectAppUsesStub(page.request);
});

// ---------------------------------------------------------------------------

/** Runs the real OAuth round trip: doqtri -> stub consent -> callback -> profile. */
async function connectAs(page: Page, qditUser: string) {
  await stub.consentAs(qditUser);
  await page.goto("/api/integrations/qdit/connect");
  await page.waitForURL(/\/vault\/profile/);
  await expect(page.getByTestId("qdit-outcome")).toContainText(/connected/i);
}

async function newProject(name: string, members: Parameters<typeof stub.project>[1]): Promise<string> {
  const id = await stub.project(name, members);
  projectIds.push(id);
  return id;
}

async function seedTeamNote(prefix: string): Promise<{ id: string; title: string }> {
  const title = uniqueTitle(prefix);
  const id = await seedNote(title, PLAN(title), undefined, { workspaceId: team, userId: aId });
  return { id, title };
}

/** Links the note to `projectId` and, if asked, makes a milestone from a heading, as `page`'s user. */
async function linkThroughApi(page: Page, docId: string, projectId: string, nodeId?: string, nodeLabel?: string) {
  const linked = await page.request.post(`/api/integrations/qdit/docs/${docId}/project`, { data: { projectId } });
  expect(linked.status(), await linked.text()).toBe(200);
  if (!nodeId) return null;
  const made = await page.request.post(`/api/integrations/qdit/docs/${docId}/milestones`, { data: { nodeId, nodeLabel } });
  expect(made.status(), await made.text()).toBe(201);
  const [row] = await serviceRest<{ id: string; qdit_milestone_id: string; qdit_link_id: string }[]>(
    `node_links?document_id=eq.${docId}&provider=eq.qdit&node_id=eq.${nodeId}&select=id,qdit_milestone_id,qdit_link_id`,
  );
  return row;
}

function qditLinkRows(docId: string) {
  return serviceRest<{ id: string; node_id: string; qdit_state: string }[]>(
    `node_links?document_id=eq.${docId}&provider=eq.qdit&select=id,node_id,qdit_state`,
  );
}

function docProjectLink(docId: string) {
  return serviceRest<{ project_id: string }[]>(`doc_project_links?document_id=eq.${docId}&select=project_id`);
}

async function postWebhook(page: Page, hook: ReturnType<typeof signedWebhook>) {
  webhookIds.push(hook.id);
  return page.request.post("/api/integrations/qdit/webhook", { headers: hook.headers, data: hook.body });
}

function card(page: Page) {
  return page.getByTestId("qdit-links").getByTestId("qdit-milestone-card");
}

/**
 * The card fetches only once it scrolls into view (IntersectionObserver in
 * qdit-milestone-card.tsx), and the qdit section sits below the graph, under
 * the fold at 900 px. Scroll first, then read its state.
 */
async function shownCard(page: Page) {
  await card(page).scrollIntoViewIfNeeded();
  return card(page);
}

// ---------------------------------------------------------------------------

test.describe("connecting", () => {
  test("connect through qdit's consent, then disconnect", async ({ page }) => {
    await connectAs(page, qa);
    await expect(page.getByTestId("qdit-outcome")).toHaveText("qdit is connected.");
    await expect(page.getByTestId("qdit-status")).toHaveText("Connected");

    // doqtri asked qdit who this is, with the token the stub issued.
    const log = await stub.log();
    expect(log.some((call) => call.method === "GET" && call.path === "/me" && call.user === qa && call.status === 200)).toBe(true);

    const toggle = page.getByTestId("qdit-toggle");
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await page.getByTestId("qdit-disconnect").click();
    await page.getByTestId("qdit-disconnect-confirm").click();
    // The stub advertises no revocation_endpoint, as Supabase's does not (section 5).
    await expect(page.getByText(/qdit is disconnected here\. To remove Doqtri from qdit too/)).toBeVisible();
    await expect(page.getByTestId("qdit-status")).toHaveText("Not connected");
  });

  test("declining in qdit connects nothing", async ({ page }) => {
    await stub.denyConsent();
    await page.goto("/api/integrations/qdit/connect");
    await page.waitForURL(/\/vault\/profile/);
    await expect(page.getByTestId("qdit-outcome")).toHaveText(
      "You didn't allow Doqtri in qdit, so nothing was connected.",
    );
    await expect(page.getByTestId("qdit-status")).not.toHaveText("Connected");
  });

  test("reconnecting as another qdit account says which one it replaced (D-66)", async ({ page }) => {
    const other = await stub.user("qa-second");
    await connectAs(page, qa);
    await connectAs(page, other);
    await expect(page.getByTestId("qdit-outcome")).toHaveText("Now connected as qa-second (was qa).");
    await connectAs(page, qa);
  });

  test("a grant revoked in qdit turns into Reconnect, and reconnecting recovers", async ({ page }) => {
    await connectAs(page, qa);
    await stub.revoke(qa);

    // The next call is refused, the refresh is refused (invalid_grant), and
    // doqtri drops the tokens rather than retrying forever.
    const projects = await page.request.get("/api/integrations/qdit/projects");
    expect(projects.status()).toBe(409);
    expect((await projects.json()).code).toBe("QDIT_NOT_CONNECTED");
    const [row] = await serviceRest<{ status: string; access_token_ciphertext: string | null }[]>(
      `integration_connections?user_id=eq.${aId}&provider=eq.qdit&select=status,access_token_ciphertext`,
    );
    expect(row).toEqual({ status: "needs_reconnect", access_token_ciphertext: null });

    await page.goto("/vault/profile?tab=apps");
    await expect(page.getByTestId("qdit-status")).toHaveText("Reconnect needed");

    const note = await seedTeamNote("Revoked Plan");
    try {
      await page.goto(`/vault/${note.id}`);
      await expect(page.getByTestId("qdit-links").getByRole("link", { name: "Reconnect qdit" })).toBeVisible();
    } finally {
      await deleteNote(note.id);
    }

    await connectAs(page, qa);
    await expect(page.getByTestId("qdit-status")).toHaveText("Connected");
  });
});

// ---------------------------------------------------------------------------

test.describe("linking a plan", () => {
  test.beforeEach(async ({ page }) => {
    await connectAs(page, qa);
  });

  test("link a note, make a milestone from a heading, then unlink both", async ({ page }) => {
    const note = await seedTeamNote("Escrow Plan");
    try {
      await page.goto(`/vault/${note.id}`);
      const panel = page.getByTestId("qdit-links");

      await panel.getByRole("button", { name: "Link to a qdit project" }).click();
      await panel.getByLabel("qdit project").click();
      await page.getByRole("option", { name: projectName }).click();
      await panel.getByRole("button", { name: "Link", exact: true }).click();
      await expect(page.getByText("Note linked to qdit")).toBeVisible();
      await expect(panel).toContainText(`Project ${projectName}`);
      expect((await stub.docLink(note.id))?.project_id).toBe(project);

      await panel.getByLabel("Heading to link").click();
      await page.getByRole("option", { name: "Build the escrow" }).click();
      await panel.getByRole("button", { name: "Create milestone" }).click();
      await expect(page.getByText("Milestone created in qdit")).toBeVisible();

      // The card reads the milestone back from qdit as this user.
      await expect(await shownCard(page)).toHaveAttribute("data-state", "loaded");
      await expect(await shownCard(page)).toContainText("Proposed");
      await expect(await shownCard(page)).toContainText("Not on chain yet");

      const [row] = await qditLinkRows(note.id);
      expect(row).toMatchObject({ node_id: H_BUILD, qdit_state: "linked" });
      const [{ qdit_milestone_id: milestoneId }] = await serviceRest<{ qdit_milestone_id: string }[]>(
        `node_links?id=eq.${row.id}&select=qdit_milestone_id`,
      );
      const milestone = await stub.milestone(milestoneId);
      expect(milestone).toMatchObject({ title: "Build the escrow", link: { doc_id: note.id, node_id: H_BUILD } });

      await panel.getByRole("button", { name: "Unlink the milestone from “Build the escrow”" }).click();
      await expect(page.getByText("Unlinked. The milestone stays in qdit.")).toBeVisible();
      expect(await qditLinkRows(note.id)).toEqual([]);
      expect((await stub.milestone(milestoneId)).link).toBeNull();

      await panel.getByRole("button", { name: "Unlink project" }).click();
      await panel.getByRole("button", { name: "Unlink, and every milestone link" }).click();
      await expect(page.getByText("Note unlinked from qdit. Its milestones stay in qdit.")).toBeVisible();
      expect(await docProjectLink(note.id)).toEqual([]);
      expect(await stub.docLink(note.id)).toBeNull();
    } finally {
      await deleteNote(note.id);
    }
  });

  test("renaming a linked heading renames the milestone in qdit (D-12)", async ({ page }) => {
    const note = await seedTeamNote("Rename Plan");
    try {
      const row = await linkThroughApi(page, note.id, project, H_BUILD, "Build the escrow");
      await page.goto(`/vault/${note.id}`);
      await replaceEditorText(page, PLAN(note.title).replace("## Build the escrow", "## Build the escrow contract"));
      await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });

      // The save hook pushes the new title to qdit in the background.
      await expect
        .poll(async () => (await stub.milestone(row!.qdit_milestone_id)).title, { timeout: 20_000 })
        .toBe("Build the escrow contract");
    } finally {
      await deleteNote(note.id);
    }
  });

  test("a signed webhook records qdit's status; forged, stale and repeated ones do nothing", async ({ page }) => {
    const note = await seedTeamNote("Webhook Plan");
    try {
      const row = await linkThroughApi(page, note.id, project, H_SHIP, "Ship it");
      const milestoneId = row!.qdit_milestone_id;
      await stub.setMilestoneStatus(milestoneId, "approved");
      const event = { project_id: project, milestone_id: milestoneId, status: "approved" };

      const forged = await postWebhook(page, signedWebhook(event, { secret: "not-the-secret" }));
      expect(forged.status()).toBe(401);

      const stale = await postWebhook(page, signedWebhook(event, { timestamp: Math.floor(Date.now() / 1000) - 301 }));
      expect(stale.status()).toBe(401);

      const good = signedWebhook(event);
      const accepted = await postWebhook(page, good);
      expect(accepted.status(), await accepted.text()).toBe(200);
      expect(await accepted.json()).toEqual({ ok: true });

      // A project with no chain reads as unregistered: qdit's word is kept, nothing is suggested from it.
      const [state] = await serviceRest<{ qdit_status: string; chain_status: string }[]>(
        `qdit_milestone_states?milestone_id=eq.${milestoneId}&select=qdit_status,chain_status`,
      );
      expect(state).toEqual({ qdit_status: "approved", chain_status: "unregistered" });

      // qdit retries resend the same id with a fresh signature.
      const again = await postWebhook(page, signedWebhook({ ...event, id: good.id }));
      expect(await again.json()).toEqual({ ok: true, duplicate: true });

      const unknown = await postWebhook(page, signedWebhook({ ...event, event: "milestone.deleted" }));
      expect(await unknown.json()).toEqual({ ok: true, ignored: "unknown_event" });

      const otherMilestone = await postWebhook(
        page,
        signedWebhook({ ...event, milestone_id: "00000000-0000-4000-8000-00000000e2e0" }),
      );
      expect(await otherMilestone.json()).toEqual({ ok: true, ignored: "unlinked" });
    } finally {
      await deleteNote(note.id);
    }
  });
});

// ---------------------------------------------------------------------------

test.describe("when qdit and doqtri disagree", () => {
  test.beforeEach(async ({ page }) => {
    await connectAs(page, qa);
  });

  test("a milestone deleted in qdit: the card says so and doqtri keeps the link until told", async ({ page }) => {
    const note = await seedTeamNote("Vanished Milestone");
    try {
      const row = await linkThroughApi(page, note.id, project, H_BUILD, "Build the escrow");
      await stub.deleteMilestone(row!.qdit_milestone_id);

      await page.goto(`/vault/${note.id}`);
      // qdit answers 404, which never reveals whether it exists (section 6).
      await expect(await shownCard(page)).toHaveAttribute("data-state", "no_access");
      await expect(await shownCard(page)).toContainText("You don't have access to this milestone in qdit");

      // Unlinking cannot be confirmed: qdit 404s the link and the milestone.
      const unlink = await page.request.delete(`/api/integrations/qdit/links/${row!.id}`);
      expect(unlink.status()).toBe(409);
      expect((await unlink.json()).code).toBe("QDIT_UNCONFIRMED");
      expect(await qditLinkRows(note.id)).toHaveLength(1);
    } finally {
      await deleteNote(note.id);
    }
  });

  test("a project deleted in qdit: unlink is unconfirmed, and an admin forgets it here (D-68)", async ({ page }) => {
    const gone = await newProject(uniqueTitle("Doomed"), { [qa]: "admin" });
    const note = await seedTeamNote("Orphaned Plan");
    try {
      await linkThroughApi(page, note.id, gone, H_BUILD, "Build the escrow");
      await stub.deleteProject(gone);

      await page.goto(`/vault/${note.id}`);
      const panel = page.getByTestId("qdit-links");
      await panel.getByRole("button", { name: "Unlink project" }).click();
      await panel.getByRole("button", { name: "Unlink, and every milestone link" }).click();
      await expect(panel).toContainText("qdit no longer shows you this project.");
      expect(await docProjectLink(note.id)).toHaveLength(1);

      await panel.getByRole("button", { name: "Forget link here" }).click();
      await panel.getByRole("button", { name: "Forget it in Doqtri" }).click();
      await expect(page.getByText(/^Link forgotten in Doqtri\./)).toBeVisible();
      expect(await docProjectLink(note.id)).toEqual([]);
      expect(await qditLinkRows(note.id)).toEqual([]);
    } finally {
      await deleteNote(note.id);
    }
  });

  test("a note qdit already links to another project cannot be linked here", async ({ page }) => {
    const elsewhere = await newProject(uniqueTitle("Elsewhere"), { [qa]: "admin" });
    const note = await seedTeamNote("Taken Plan");
    try {
      await stub.linkDocElsewhere(elsewhere, note.id);
      const res = await page.request.post(`/api/integrations/qdit/docs/${note.id}/project`, { data: { projectId: project } });
      expect(res.status()).toBe(409);
      expect((await res.json()).code).toBe("QDIT_LINKED_ELSEWHERE");
      expect(await docProjectLink(note.id)).toEqual([]);
    } finally {
      await deleteNote(note.id);
    }
  });

  test("losing the qdit project: the card shows no access and new milestones are refused", async ({ page }) => {
    const shared = await newProject(uniqueTitle("Shared"), { [qa]: "admin" });
    const note = await seedTeamNote("Lost Access Plan");
    try {
      await linkThroughApi(page, note.id, shared, H_BUILD, "Build the escrow");
      await stub.setRole(shared, qa, null);

      await page.goto(`/vault/${note.id}`);
      await expect(await shownCard(page)).toHaveAttribute("data-state", "no_access");
      const made = await page.request.post(`/api/integrations/qdit/docs/${note.id}/milestones`, {
        data: { nodeId: H_SHIP, nodeLabel: "Ship it" },
      });
      expect(made.status()).toBe(404);
      expect((await made.json()).code).toBe("QDIT_NOT_FOUND");
      // The existing link stays: doqtri only drops it when qdit confirms.
      expect(await qditLinkRows(note.id)).toHaveLength(1);
    } finally {
      await stub.setRole(shared, qa, "admin");
      await deleteNote(note.id);
    }
  });
});

// ---------------------------------------------------------------------------

test.describe("roles across both teams", () => {
  let bPage: Page;

  test.beforeEach(async ({ page }) => {
    await connectAs(page, qa);
    bPage = await bContext.newPage();
    await connectAs(bPage, qb);
  });

  test.afterEach(async () => {
    await bPage.close();
    await serviceRest(`workspace_members?workspace_id=eq.${team}&user_id=eq.${bId}`, { method: "DELETE" });
    await serviceRest(`workspace_chain_jobs?workspace_id=eq.${team}`, { method: "DELETE" });
    await stub.setRole(project, qb, null);
  });

  test("a doqtri editor cannot link the project, even as a qdit admin, but can make milestones", async ({ page }) => {
    await setMember(team, bId, "editor");
    await stub.setRole(project, qb, "admin");
    const note = await seedTeamNote("Editor Plan");
    try {
      await bPage.goto(`/vault/${note.id}`);
      await expect(bPage.getByTestId("qdit-links")).toContainText("An admin of this workspace links the note to a qdit project.");
      const refused = await bPage.request.post(`/api/integrations/qdit/docs/${note.id}/project`, { data: { projectId: project } });
      expect(refused.status()).toBe(403);

      await linkThroughApi(page, note.id, project);
      const made = await bPage.request.post(`/api/integrations/qdit/docs/${note.id}/milestones`, {
        data: { nodeId: H_SHIP, nodeLabel: "Ship it" },
      });
      expect(made.status(), await made.text()).toBe(201);
    } finally {
      await deleteNote(note.id);
    }
  });

  test("a doqtri viewer can see links but not make milestones", async ({ page }) => {
    await setMember(team, bId, "viewer");
    await stub.setRole(project, qb, "admin");
    const note = await seedTeamNote("Viewer Plan");
    try {
      await linkThroughApi(page, note.id, project);
      await bPage.goto(`/vault/${note.id}`);
      const panel = bPage.getByTestId("qdit-links");
      await expect(panel).toContainText(`Project ${projectName}`);
      await expect(panel.getByRole("button", { name: "Create milestone" })).toHaveCount(0);

      const made = await bPage.request.post(`/api/integrations/qdit/docs/${note.id}/milestones`, {
        data: { nodeId: H_BUILD, nodeLabel: "Build the escrow" },
      });
      expect(made.status()).toBe(403);
    } finally {
      await deleteNote(note.id);
    }
  });

  test("a qdit member cannot link a doc to the project; a qdit viewer cannot make milestones", async ({ page }) => {
    const memberOnly = await newProject(uniqueTitle("Member Only"), { [qa]: "member", [qb]: "viewer" });
    await setMember(team, bId, "editor");
    const note = await seedTeamNote("qdit Roles Plan");
    try {
      // A is a doqtri owner but only a qdit member here: qdit's admin rule wins.
      const listed = await page.request.get("/api/integrations/qdit/projects");
      const row = ((await listed.json()) as { projects: { id: string; can_link: boolean }[] }).projects.find(
        (p) => p.id === memberOnly,
      );
      expect(row?.can_link).toBe(false);
      const refused = await page.request.post(`/api/integrations/qdit/docs/${note.id}/project`, { data: { projectId: memberOnly } });
      expect(refused.status()).toBe(403);
      expect((await refused.json()).code).toBe("QDIT_FORBIDDEN");

      // Linked to the main project, B (doqtri editor) tries to make a
      // milestone while only a qdit viewer there.
      await stub.setRole(project, qb, "viewer");
      await linkThroughApi(page, note.id, project);
      const made = await bPage.request.post(`/api/integrations/qdit/docs/${note.id}/milestones`, {
        data: { nodeId: H_BUILD, nodeLabel: "Build the escrow" },
      });
      expect(made.status()).toBe(403);
      expect((await made.json()).code).toBe("QDIT_FORBIDDEN");
      expect((await stub.log()).some((call) => call.path === "/milestones" && call.user === qb && call.status === 403)).toBe(true);
    } finally {
      await deleteNote(note.id);
    }
  });

  test("a teammate on another qdit account sees no access to the milestone", async ({ page }) => {
    await setMember(team, bId, "viewer");
    const note = await seedTeamNote("Other Account Plan");
    try {
      const row = await linkThroughApi(page, note.id, project, H_BUILD, "Build the escrow");
      // qb is not in the project at all.
      await bPage.goto(`/vault/${note.id}`);
      await expect(await shownCard(bPage)).toHaveAttribute("data-state", "no_access");

      const direct = await bPage.request.get(`/api/integrations/qdit/milestones/${row!.qdit_milestone_id}`);
      expect(direct.status()).toBe(403);
      expect((await direct.json()).code).toBe("QDIT_NO_ACCESS");
    } finally {
      await deleteNote(note.id);
    }
  });

  test("someone outside the doqtri workspace reaches none of the note's qdit routes", async ({ page }) => {
    await stub.setRole(project, qb, "admin");
    const note = await seedTeamNote("Outsider Plan");
    try {
      await linkThroughApi(page, note.id, project, H_BUILD, "Build the escrow");
      const status = await bPage.request.post(`/api/integrations/qdit/docs/${note.id}/status`, { data: {} });
      expect(status.status()).toBe(404);
      const made = await bPage.request.post(`/api/integrations/qdit/docs/${note.id}/milestones`, {
        data: { nodeId: H_SHIP, nodeLabel: "Ship it" },
      });
      expect(made.status()).toBe(404);
      const unlink = await bPage.request.delete(`/api/integrations/qdit/docs/${note.id}/project`);
      expect(unlink.status()).toBe(404);
      expect(await docProjectLink(note.id)).toHaveLength(1);
    } finally {
      await deleteNote(note.id);
    }
  });
});
