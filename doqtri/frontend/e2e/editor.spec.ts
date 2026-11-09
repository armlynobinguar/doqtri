import { test, expect } from "@playwright/test";
import {
  deleteNote,
  editableEditor,
  editorLine,
  expectEditorText,
  noteEditor,
  placeCaretAfter,
  readNote,
  replaceEditorText,
  seedNote,
  uniqueTitle,
} from "./helpers";

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
    await expect(noteEditor(page)).toBeVisible();
    await expectEditorText(page, /# Editor Note/);

    // Live preview: with no caret in it, the heading renders, its hash hidden.
    await expect(editorLine(page, "Editor Note")).toHaveText("Editor Note");
    await expect(editorLine(page, "Editor Note")).toHaveClass(/cm-lp-h1/);
  });

  test("word count updates in the status bar as you type", async ({ page }) => {
    await page.goto(`/vault/${noteId}`);
    await editableEditor(page);

    // "# Editor Note\n\nOriginal body." -> 5 words
    await expect(page.getByText(/^\d+ words?$/)).toContainText("5 words");

    await placeCaretAfter(page, "Original body.");
    await page.keyboard.type(" plus three more words");

    await expect(page.getByText(/^\d+ words?$/)).toContainText("9 words");
  });

  test("an edit debounce-saves and survives a reload", async ({ page }) => {
    await page.goto(`/vault/${noteId}`);
    await replaceEditorText(page, "# Editor Note\n\n## New Section\n\nEdited body.\n");

    // The status bar is the only surface that reports the debounced write.
    await expect(page.getByText("Saving…")).toBeVisible();
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });

    // Confirm it actually reached Postgres, not just the UI.
    const stored = await readNote(noteId);
    expect(stored.markdown).toContain("## New Section");
    expect(stored.markdown).toContain("Edited body.");

    await page.reload();
    await expectEditorText(page, /## New Section/);
  });

  test("selecting a note in the explorer opens it", async ({ page }) => {
    const otherTitle = uniqueTitle("Other Note");
    const otherId = await seedNote(otherTitle, "# Other Note\n");

    try {
      await page.goto(`/vault/${noteId}`);
      await page.getByRole("link", { name: otherTitle }).click();

      await page.waitForURL(`**/vault/${otherId}`);
      await expectEditorText(page, /# Other Note/);
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
