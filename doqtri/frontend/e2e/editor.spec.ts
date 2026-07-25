import { test, expect } from "@playwright/test";
import { deleteNote, readNote, seedNote, uniqueTitle } from "./helpers";

test.describe("editor", () => {
  let noteId: string;
  let title: string;

  test.beforeEach(async () => {
    title = uniqueTitle("Editor Note");
    noteId = await seedNote(title, "# Editor Note\n\nOriginal body.\n");
  });

  test.afterEach(async () => {
    await deleteNote(noteId);
  });

  test("the markdown editor mounts client-side", async ({ page }) => {
    await page.goto(`/vault/${noteId}`);

    // ssr:false means the fallback shows first, then the real editor replaces it.
    const textarea = page.locator("textarea.w-md-editor-text-input");
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveValue(/# Editor Note/);

    // Live preview pane renders the markdown too.
    await expect(
      page.locator(".wmde-markdown").getByRole("heading", { name: "Editor Note" }),
    ).toBeVisible();
  });

  test("word count updates in the status bar as you type", async ({ page }) => {
    await page.goto(`/vault/${noteId}`);
    const textarea = page.locator("textarea.w-md-editor-text-input");
    await expect(textarea).toBeVisible();

    // "# Editor Note\n\nOriginal body." -> 5 words
    await expect(page.getByText(/^\d+ words?$/)).toContainText("5 words");

    await textarea.click();
    await textarea.press("End");
    await textarea.pressSequentially(" plus three more words");

    await expect(page.getByText(/^\d+ words?$/)).toContainText("9 words");
  });

  test("an edit debounce-saves and survives a reload", async ({ page }) => {
    await page.goto(`/vault/${noteId}`);
    const textarea = page.locator("textarea.w-md-editor-text-input");
    await expect(textarea).toBeVisible();

    await textarea.click();
    await textarea.press("ControlOrMeta+a");
    await textarea.fill("# Editor Note\n\n## New Section\n\nEdited body.\n");

    // The status bar is the only surface that reports the debounced write.
    await expect(page.getByText("Saving…")).toBeVisible();
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });

    // Confirm it actually reached Postgres, not just the UI.
    const stored = await readNote(noteId);
    expect(stored.markdown).toContain("## New Section");
    expect(stored.markdown).toContain("Edited body.");

    await page.reload();
    await expect(page.locator("textarea.w-md-editor-text-input")).toHaveValue(
      /## New Section/,
    );
  });

  test("selecting a note in the explorer opens it", async ({ page }) => {
    const otherTitle = uniqueTitle("Other Note");
    const otherId = await seedNote(otherTitle, "# Other Note\n");

    try {
      await page.goto(`/vault/${noteId}`);
      await page.getByRole("link", { name: otherTitle }).click();

      await page.waitForURL(`**/vault/${otherId}`);
      await expect(page.locator("textarea.w-md-editor-text-input")).toHaveValue(
        /# Other Note/,
      );
    } finally {
      await deleteNote(otherId);
    }
  });

  test("regenerate is gated behind an explicit overwrite warning", async ({ page }) => {
    await page.goto(`/vault/${noteId}`);
    await page.getByRole("button", { name: "Regenerate" }).click();

    await expect(
      page.getByRole("heading", { name: "Regenerate this note" }),
    ).toBeVisible();
    await expect(page.getByText("This replaces your current version")).toBeVisible();

    // Cancel must leave the note untouched — no AI call, no overwrite.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("heading", { name: "Regenerate this note" }),
    ).toBeHidden();

    const stored = await readNote(noteId);
    expect(stored.markdown).toContain("Original body.");
  });
});
