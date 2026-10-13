import { test, expect, type Page } from "@playwright/test";
import { deleteNote, seedNote, uniqueTitle } from "./helpers";

/*
 * Typing `[[` in the editor lists the vault's notes, Obsidian-style, and
 * picking one completes the link.
 */

const TEXTAREA = "textarea.w-md-editor-text-input";

async function caretAtEnd(page: Page) {
  const textarea = page.locator(TEXTAREA);
  await expect(textarea).toBeVisible();
  await textarea.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  return textarea;
}

test.describe("[[ link autocomplete", () => {
  const ids: string[] = [];
  let target: string;
  let sibling: string;

  test.beforeEach(async () => {
    // A shared, unusual token so the filter narrows to exactly these two.
    const token = `Qz${Date.now().toString(36)}`;
    target = `${token} Alpha target`;
    sibling = `${token} Beta sibling`;
    ids.push(await seedNote(target, "# Alpha\n"));
    ids.push(await seedNote(sibling, "# Beta\n"));
  });

  test.afterEach(async () => {
    while (ids.length) await deleteNote(ids.pop()!);
  });

  test("Enter completes the highlighted note and closes the list", async ({ page }) => {
    const source = await seedNote(uniqueTitle("Linker"), "# Source\n\nsee ");
    ids.push(source);
    await page.goto(`/vault/${source}`);
    const textarea = await caretAtEnd(page);

    await page.keyboard.type("[[");
    const list = page.getByRole("listbox", { name: "Link to note" });
    await expect(list).toBeVisible();

    await page.keyboard.type(target.split(" ")[0]);
    const options = list.getByRole("option");
    await expect(options).toHaveCount(2);
    await expect(options.first()).toHaveAttribute("aria-selected", "true");

    // Down to the second, back up to the first: the highlight wraps and moves.
    await page.keyboard.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");

    await expect(list).toBeHidden();
    // Enter picked the note rather than starting a new line.
    await expect(textarea).toHaveValue(`# Source\n\nsee [[${target}]]`);

    // The caret lands past `]]`, so typing continues the sentence.
    await page.keyboard.type(" next");
    await expect(textarea).toHaveValue(`# Source\n\nsee [[${target}]] next`);
  });

  test("click picks a note, Esc dismisses, and the active note is not offered", async ({
    page,
  }) => {
    const sourceTitle = uniqueTitle("Linker");
    const source = await seedNote(sourceTitle, "# Source\n\n");
    ids.push(source);
    await page.goto(`/vault/${source}`);
    const textarea = await caretAtEnd(page);
    const list = page.getByRole("listbox", { name: "Link to note" });

    await page.keyboard.type("[[");
    await expect(list).toBeVisible();
    await expect(list.getByRole("option", { name: sourceTitle })).toHaveCount(0);

    await page.keyboard.type("beta sib");
    await list.getByRole("option", { name: sibling }).click();
    await expect(list).toBeHidden();
    await expect(textarea).toHaveValue(`# Source\n\n[[${sibling}]]`);
    await expect(textarea).toBeFocused();

    await page.keyboard.type(" and [[Alp");
    await expect(list).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    // Still dismissed while typing inside the same link.
    await page.keyboard.type("ha");
    await expect(list).toBeHidden();
    await page.keyboard.type("]]");
    await expect(textarea).toHaveValue(`# Source\n\n[[${sibling}]] and [[Alpha]]`);
  });

  test("completing inside a closed link replaces its target", async ({ page }) => {
    const source = await seedNote(uniqueTitle("Linker"), "# Source\n\n[[Old]] tail");
    ids.push(source);
    await page.goto(`/vault/${source}`);
    const textarea = page.locator(TEXTAREA);
    await expect(textarea).toBeVisible();
    await textarea.evaluate((el: HTMLTextAreaElement) => {
      const pos = el.value.indexOf("Old") + 1;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
    // Replace "O" with the token so the list narrows to our notes.
    await page.keyboard.press("Backspace");
    await page.keyboard.type(target.split(" ")[0]);

    const list = page.getByRole("listbox", { name: "Link to note" });
    await expect(list.getByRole("option")).toHaveCount(2);
    await page.keyboard.press("Tab");
    await expect(textarea).toHaveValue(`# Source\n\n[[${target}]] tail`);
  });
});
