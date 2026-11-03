import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { shortenAddress } from "@/lib/wallet";
import { assertNotProduction } from "./guard";
import { deleteNote, personalWorkspaceId, seedNote, serviceRest, testUserId, uniqueTitle, userIdForWallet } from "./helpers";
import { createTeamWorkspace, deleteWorkspace, memberRole, setMember } from "./teams";
import { e2eKeypair, signedInContext } from "./wallet-session";

/**
 * Workspaces with two people (DOQ-16; WP-1.5, WP-1.6, WP-1.7).
 *
 * A is the suite's default session and owns a team workspace made for this
 * file. B is a second wallet account in a browser context of its own, so the
 * two act as two people at two computers. Chain jobs never run here:
 * NEXT_PUBLIC_REGISTRY_EDITORS is unset in e2e, so a removal only queues one.
 */

const B = e2eKeypair("doqtri-e2e-wallet-b");
const B_SHORT = shortenAddress(B.publicKey());

const editor = (page: Page) => page.locator("textarea.w-md-editor-text-input");

let aId: string;
let bId: string;
let team: string;
let teamName: string;
let bContext: BrowserContext;

test.beforeAll(async ({ browser }) => {
  assertNotProduction();
  // Signing B in first creates B's account and personal workspace.
  bContext = await signedInContext(browser, B);
  aId = await testUserId();
  bId = await userIdForWallet(B.publicKey());
  teamName = uniqueTitle("E2E Team");
  team = await createTeamWorkspace(teamName, aId);
});

test.afterAll(async () => {
  await bContext?.close();
  if (team) await deleteWorkspace(team);
});

async function switchWorkspace(page: Page, name: string) {
  await page.getByTestId("workspace-switcher").click();
  await page.getByTestId("workspace-option").filter({ hasText: name }).click();
  await expect(page.getByTestId("workspace-switcher")).toHaveAccessibleName(new RegExp(`Workspace: ${name}`));
}

test.describe("workspace scope", () => {
  test("explorer, quick switcher, graph and mindmap show only the active workspace", async ({ page }) => {
    const teamA = uniqueTitle("Team Alpha");
    const teamB = uniqueTitle("Team Beta");
    const mine = uniqueTitle("Personal Only");
    const into = { workspaceId: team, userId: aId };
    const teamAId = await seedNote(teamA, `# ${teamA}\n\nSee [[${teamB}]].\n`, undefined, into);
    const teamBId = await seedNote(teamB, `# ${teamB}\n\nLeaf.\n`, undefined, into);
    const mineId = await seedNote(mine, `# ${mine}\n\nPersonal.\n`);

    try {
      await page.goto("/vault");
      const explorer = page.getByRole("complementary");
      await expect(explorer.getByRole("link", { name: mine })).toBeVisible();
      await expect(explorer.getByRole("link", { name: teamA })).toHaveCount(0);

      await switchWorkspace(page, teamName);
      await expect(explorer.getByRole("link", { name: teamA })).toBeVisible();
      await expect(explorer.getByRole("link", { name: teamB })).toBeVisible();
      await expect(explorer.getByRole("link", { name: mine })).toHaveCount(0);
      await expect(explorer.locator('a[href^="/vault/"]')).toHaveCount(2);

      // The quick switcher reads the same list.
      const input = page.getByPlaceholder("Go to note…");
      await expect(async () => {
        await page.keyboard.press("ControlOrMeta+k");
        await expect(input).toBeVisible({ timeout: 2_000 });
      }).toPass();
      await input.fill(mine);
      await expect(page.getByRole("option", { name: mine })).toHaveCount(0);
      await input.fill(teamA);
      await expect(page.getByRole("option", { name: teamA })).toBeVisible();
      await page.keyboard.press("Escape");

      // Graph and global mindmap count the team's two notes, not the personal
      // vault. The status bar repeats the count, hence first(): either one is
      // the workspace's, and both are wrong if scoping breaks.
      await page.goto("/vault/graph");
      await expect(page.getByText(/^2 notes$/).first()).toBeVisible();
      await page.goto("/vault/mindmap");
      await expect(page.getByText(/^2 notes$/).first()).toBeVisible();

      // Opening a note from another of your workspaces switches to it.
      await page.goto(`/vault/${mineId}`);
      await page.waitForURL(`**/vault/${mineId}`);
      await expect(page.getByTestId("workspace-switcher")).toHaveAccessibleName(/Workspace: Personal/);
      await expect(explorer.getByRole("link", { name: teamA })).toHaveCount(0);
    } finally {
      await deleteNote(teamAId);
      await deleteNote(teamBId);
      await deleteNote(mineId);
    }
  });

  test("an outsider gets a 404 for another team's note", async () => {
    const title = uniqueTitle("Team Private");
    const id = await seedNote(title, `# ${title}\n\nSecret.\n`, undefined, { workspaceId: team, userId: aId });
    const page = await bContext.newPage();
    try {
      expect(await memberRole(team, bId)).toBeNull();
      const res = await page.goto(`/vault/${id}`);
      expect(res?.status()).toBe(404);
      const save = await page.request.put(`/api/notes/${id}`, {
        data: { markdown: "# hijack", version: 1, session: randomUUID() },
      });
      expect([403, 404]).toContain(save.status());
      expect((await serviceRest<{ markdown: string }[]>(`documents?id=eq.${id}&select=markdown`))[0].markdown).toContain(
        "Secret.",
      );
    } finally {
      await page.close();
      await deleteNote(id);
    }
  });
});

test.describe("members screen", () => {
  test.afterEach(async () => {
    // Back to "B is not a member" for the next test, whatever this one did.
    await serviceRest(`workspace_invites?workspace_id=eq.${team}`, { method: "DELETE" });
    await serviceRest(`workspace_members?workspace_id=eq.${team}&user_id=eq.${bId}`, { method: "DELETE" });
    await serviceRest(`workspace_chain_jobs?workspace_id=eq.${team}`, { method: "DELETE" });
  });

  test("invite by wallet, join, change role, remove: B loses the team's notes", async ({ page }) => {
    const title = uniqueTitle("Team Roster Note");
    const noteId = await seedNote(title, `# ${title}\n\nFor members.\n`, undefined, { workspaceId: team, userId: aId });
    const bPage = await bContext.newPage();
    try {
      // A invites B as a viewer.
      await page.goto(`/vault/workspace/members?ws=${team}`);
      await expect(page.getByRole("heading", { level: 1, name: teamName })).toBeVisible();
      await page.getByTestId("invite-input").fill(B.publicKey());
      await page.getByLabel("Role", { exact: true }).click();
      await page.getByRole("option", { name: "Viewer" }).click();
      await page.getByTestId("invite-send").click();
      await expect(page.getByText(/^Invite sent\./)).toBeVisible();
      await expect(page.getByTestId("pending-invites")).toContainText("Invited as viewer", { ignoreCase: true });

      // B sees it on their own members screen and joins.
      await bPage.goto("/vault/workspace/members");
      const invite = bPage.getByTestId("my-invites").locator("li").filter({ hasText: teamName });
      await expect(invite).toBeVisible();
      await invite.getByRole("button", { name: "Join" }).click();
      await expect(bPage.getByText(`You joined ${teamName}.`)).toBeVisible();
      await expect.poll(() => memberRole(team, bId)).toBe("viewer");

      // B can now open the team's note.
      const opened = await bPage.goto(`/vault/${noteId}`);
      expect(opened?.status()).toBe(200);
      await expect(bPage.getByTestId("read-only-banner")).toBeVisible();

      // A makes B an editor.
      await page.getByRole("button", { name: "Refresh" }).click();
      const row = page.getByTestId("member-row").filter({ hasText: B_SHORT });
      await expect(row).toBeVisible();
      await page.getByLabel(`Role of ${B_SHORT}`).click();
      await page.getByRole("option", { name: "Editor" }).click();
      await expect(page.getByText(new RegExp(`${B_SHORT} is now editor`, "i"))).toBeVisible();
      await expect.poll(() => memberRole(team, bId)).toBe("editor");

      // A removes B. No confirmation step: the button removes.
      await page.getByRole("button", { name: `Remove ${B_SHORT}` }).click();
      await expect(page.getByText(`${B_SHORT} was removed.`)).toBeVisible();
      await expect.poll(() => memberRole(team, bId)).toBeNull();
      await expect(page.getByTestId("member-row").filter({ hasText: B_SHORT })).toHaveCount(0);
      // B was an editor, so the removal is queued for the chain (it does not run in e2e).
      await expect(page.getByTestId("pending-removals")).toBeVisible();

      const after = await bPage.goto(`/vault/${noteId}`);
      expect(after?.status()).toBe(404);
    } finally {
      await bPage.close();
      await deleteNote(noteId);
    }
  });

  // The RPCs behind these controls refuse the same callers; that is covered
  // per role in backend/tests/workspace_members_management.test.sql.
  test("an editor gets no invite or role controls; an owner can grant up to admin only", async ({ page }) => {
    await setMember(team, bId, "editor");
    const bPage = await bContext.newPage();
    try {
      await bPage.goto(`/vault/workspace/members?ws=${team}`);
      await expect(bPage.getByTestId("members-list")).toBeVisible();
      await expect(bPage.getByTestId("member-row")).toHaveCount(2);
      await expect(bPage.getByTestId("invite-input")).toHaveCount(0);
      await expect(bPage.getByLabel(/^Role of /)).toHaveCount(0);
      // B may still leave, but not remove the owner.
      await expect(bPage.getByRole("button", { name: "Leave this workspace" })).toBeVisible();
      await expect(bPage.getByRole("button", { name: /^Remove / })).toHaveCount(0);

      await page.goto(`/vault/workspace/members?ws=${team}`);
      await page.getByLabel(`Role of ${B_SHORT}`).click();
      await expect(page.getByRole("option")).toHaveText(["Viewer", "Editor", "Admin"]);
      await page.keyboard.press("Escape");
    } finally {
      await bPage.close();
    }
  });
});

test.describe("roles in the editor", () => {
  let noteId: string;
  let title: string;

  test.beforeEach(async () => {
    title = uniqueTitle("Team Lock Note");
    noteId = await seedNote(title, `# ${title}\n\nStart.\n`, undefined, { workspaceId: team, userId: aId });
  });

  test.afterEach(async () => {
    await deleteNote(noteId);
    await serviceRest(`workspace_members?workspace_id=eq.${team}&user_id=eq.${bId}`, { method: "DELETE" });
    await serviceRest(`workspace_chain_jobs?workspace_id=eq.${team}`, { method: "DELETE" });
  });

  test("a viewer reads, cannot edit or add notes, and the API refuses their writes", async () => {
    await setMember(team, bId, "viewer");
    const bPage = await bContext.newPage();
    try {
      await bPage.goto(`/vault/${noteId}`);
      await expect(bPage.getByTestId("read-only-banner")).toHaveText(/You can read this note but not edit it/);
      await expect(editor(bPage)).toHaveAttribute("readonly", "");
      await expect(bPage.getByRole("button", { name: "New note" })).toBeDisabled();

      const session = randomUUID();
      const lock = await bPage.request.post(`/api/notes/${noteId}/lock?session=${session}`);
      expect(lock.status()).toBe(403);
      expect((await lock.json()).code).toBe("READ_ONLY");

      const save = await bPage.request.put(`/api/notes/${noteId}`, {
        data: { markdown: "# overwritten", version: 1, session },
      });
      expect(save.status()).toBe(403);

      const create = await bPage.request.post("/api/notes", { data: { title: uniqueTitle("Nope"), workspaceId: team } });
      expect(create.status()).toBe(403);
    } finally {
      await bPage.close();
    }
  });

  test("two editors: the second sees who is editing, is read-only, and gets the saved text", async ({ page }) => {
    test.setTimeout(90_000);
    await setMember(team, bId, "editor");

    // A starts typing, which takes the lock.
    await page.goto(`/vault/${noteId}`);
    await editor(page).click();
    await editor(page).press("End");
    await editor(page).pressSequentially(" Typed by A.");
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });

    const bPage = await bContext.newPage();
    try {
      await bPage.goto(`/vault/${noteId}`);
      const banner = bPage.getByTestId("edit-lock-banner");
      await expect(banner).toContainText("is editing this note");
      // An editor cannot take the lock; only an admin or owner can.
      await expect(banner.getByRole("button", { name: "Take over" })).toHaveCount(0);
      await expect(editor(bPage)).toHaveAttribute("readonly", "");

      // The server refuses B's save, whatever the UI shows.
      const session = randomUUID();
      const [{ version }] = await serviceRest<{ version: number }[]>(`documents?id=eq.${noteId}&select=version`);
      const lock = await bPage.request.post(`/api/notes/${noteId}/lock?session=${session}`);
      expect(lock.status()).toBe(423);
      expect((await lock.json()).code).toBe("LOCKED");
      const save = await bPage.request.put(`/api/notes/${noteId}`, {
        data: { markdown: "# B wins", version, session },
      });
      expect(save.status()).toBe(423);
      expect((await save.json()).code).toBe("NOT_LOCK_HOLDER");

      // A saves again; B's read-only copy follows (polled every 15 s).
      await editor(page).pressSequentially(" Second save.");
      await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });
      await expect(editor(bPage)).toHaveValue(/Second save\./, { timeout: 30_000 });
    } finally {
      await bPage.close();
    }
  });

  test("an admin takes over; the former holder's copy turns read-only", async ({ page }) => {
    test.setTimeout(90_000);
    await setMember(team, bId, "admin");

    await page.goto(`/vault/${noteId}`);
    await editor(page).click();
    await editor(page).press("End");
    await editor(page).pressSequentially(" A holds it.");
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });

    const bPage = await bContext.newPage();
    try {
      await bPage.goto(`/vault/${noteId}`);
      const banner = bPage.getByTestId("edit-lock-banner");
      await banner.getByRole("button", { name: "Take over" }).click();
      await expect(bPage.getByText("You are editing this note now")).toBeVisible();
      await expect(banner).toHaveCount(0);
      await expect(editor(bPage)).not.toHaveAttribute("readonly", "");

      // A's next save is refused, and A's copy says who has it now.
      await editor(page).pressSequentially(" Too late.");
      await expect(page.getByText(/is editing this note now\. This copy is read-only\./)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("edit-lock-banner")).toBeVisible();
      await expect(editor(page)).toHaveAttribute("readonly", "");

      const [{ markdown }] = await serviceRest<{ markdown: string }[]>(`documents?id=eq.${noteId}&select=markdown`);
      expect(markdown).not.toContain("Too late.");
    } finally {
      await bPage.close();
    }
  });
});

test("the personal workspace stays A's own", async () => {
  // Guards the helpers above: seeding without `into` must land in A's personal workspace.
  const title = uniqueTitle("Personal Seed");
  const id = await seedNote(title, `# ${title}\n`);
  try {
    const [row] = await serviceRest<{ workspace_id: string }[]>(`documents?id=eq.${id}&select=workspace_id`);
    expect(row.workspace_id).toBe(await personalWorkspaceId(aId));
  } finally {
    await deleteNote(id);
  }
});
