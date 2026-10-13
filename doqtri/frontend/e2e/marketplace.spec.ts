import { test, expect } from "@playwright/test";
import { deleteNote, seedNote, uniqueTitle } from "./helpers";

/**
 * Template marketplace surfaces (progress/004). On-chain writes need a funded
 * wallet and a signature prompt, so this covers what renders and refuses
 * without signing: the gallery's tabs and Community list, the publish form,
 * the earnings page, and the admin queue's gate.
 */
test.describe("template marketplace", () => {
  let noteId: string;
  let title: string;

  test.beforeAll(async () => {
    title = uniqueTitle("Market Note");
    noteId = await seedNote(title, "# Market Note\n\nIntro.\n\n## Goals\nShip it.\n");
  });

  test.afterAll(async () => {
    await deleteNote(noteId);
  });

  test("templates page has Starter, Community and Yours tabs", async ({ page }) => {
    await page.goto(`/vault/${noteId}`);
    await page.getByRole("button", { name: "Templates" }).click();
    await expect(page).toHaveURL(/\/vault\/templates$/);
    const view = page.getByTestId("templates-page");
    await expect(view.getByRole("heading", { name: "Templates", level: 1 })).toBeVisible();

    // Starter is the default tab and unchanged.
    await expect(view.getByTestId("template-product-roadmap")).toBeVisible();

    await view.getByTestId("templates-tab-community").click();
    await expect(page).toHaveURL(/tab=community/);
    const gallery = view.getByTestId("community-gallery");
    await expect(gallery).toBeVisible();
    // Either community cards or the empty state, never a stuck spinner or error.
    await expect(
      gallery.locator('[data-testid^="community-template-"]').first().or(gallery.getByTestId("community-empty")),
    ).toBeVisible();
    await expect(gallery.getByRole("alert")).toHaveCount(0);
    const cards = gallery.locator('[data-testid^="community-template-"]');
    if ((await cards.count()) > 0) {
      await cards.first().click();
      // Every community preview offers a way in: use, use again, or buy.
      await expect(view.getByTestId("use-community-template").or(view.getByTestId("buy-template"))).toBeVisible();
    }

    await view.getByTestId("templates-tab-yours").click();
    await expect(page).toHaveURL(/tab=yours/);
    await expect(view.getByTestId("earnings-view")).toBeVisible();
  });

  test("a starter template opens as a new note", async ({ page }) => {
    await page.goto("/vault/templates");
    await page.getByTestId("template-sprint-plan").click();
    await page.getByTestId("use-template").click();
    await expect(page).toHaveURL(/\/vault\/[0-9a-f-]{36}$/);
    const id = page.url().split("/").pop()!;
    await deleteNote(id);
  });

  test("publish form offers free and paid pricing", async ({ page }) => {
    await page.goto(`/vault/${noteId}`);
    const open = page.getByTestId("publish-template");
    await expect(open).toBeVisible();
    await open.click();
    const form = page.getByTestId("publish-template-dialog");
    await expect(form).toBeVisible();
    await expect(form.getByRole("textbox").first()).toHaveValue(title);

    await form.getByTestId("publish-price-paid").click();
    await expect(form.getByTestId("publish-price-amount")).toBeVisible();
    await expect(form.getByTestId("publish-token")).toBeVisible();
    // Below the minimum price is caught before anything is sent.
    await form.getByTestId("publish-price-amount").fill("0.0001");
    await expect(form.getByText(/The lowest price in \w+ is/)).toBeVisible();
    await expect(form.getByTestId("publish-template-continue")).toBeDisabled();
    await form.getByTestId("publish-price-amount").fill("2");
    await expect(form.getByTestId("publish-template-continue")).toBeEnabled();
  });

  test("the old earnings address lands on the Yours tab", async ({ page }) => {
    await page.goto("/vault/earnings");
    await expect(page).toHaveURL(/\/vault\/templates\?tab=yours$/);
    await expect(page.getByTestId("earnings-view")).toBeVisible();
  });

  test("admin reports queue is hidden from non-admins", async ({ page }) => {
    // notFound() streams the not-found page, so the status isn't reliable here.
    const res = await page.goto("/admin/reports");
    expect(res?.status()).toBeLessThan(500);
    await expect(page.getByRole("heading", { name: "Template copy reports" })).toHaveCount(0);
  });
});
