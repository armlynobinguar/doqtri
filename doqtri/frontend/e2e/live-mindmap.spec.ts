import { test, expect, type Page } from "@playwright/test";
import {
  deleteNote,
  editableEditor,
  fakeMindmap,
  seedNote,
  serviceRest,
  setEditorSelection,
  uniqueTitle,
} from "./helpers";

/*
 * The live mindmap beside the editor (DOQ-31): the heading tree of the text
 * being typed, drawn on a canvas. The canvas itself is opaque to the DOM, so
 * these read the outline the pane keeps for screen readers, which is built
 * from the same tree the canvas draws.
 */

const ids: string[] = [];

test.afterEach(async () => {
  while (ids.length) await deleteNote(ids.pop()!);
});

const pane = (page: Page) => page.getByTestId("live-mindmap");
const outline = (page: Page) => page.getByTestId("live-mindmap-outline");

test.describe("live mindmap", () => {
  test("a new heading becomes a node a moment after typing, with no save", async ({ page }) => {
    const id = await seedNote(uniqueTitle("Live map"), "# Live\n\n## Goals\n");
    ids.push(id);
    await page.goto(`/vault/${id}`);
    await editableEditor(page);
    await expect(pane(page)).toBeVisible();
    await expect(pane(page).locator("canvas")).toBeVisible();
    await expect(outline(page)).toContainText("Goals");

    const saves: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "PUT" && new URL(request.url()).pathname.startsWith("/api/notes/")) saves.push(request.url());
    });
    await setEditorSelection(page, -1);
    await page.keyboard.type("## Risks");
    const typed = Date.now();
    await expect(outline(page)).toContainText("Risks", { timeout: 2_000 });
    // Rebuilt from the live text after a 250ms pause: well before the
    // debounced save (700ms) has even started.
    expect(Date.now() - typed).toBeLessThan(1_000);
    expect(saves).toEqual([]);
  });

  test("an empty note shows how to grow the tree", async ({ page }) => {
    const id = await seedNote(uniqueTitle("Empty map"), "Just prose.\n");
    ids.push(id);
    await page.goto(`/vault/${id}`);
    await expect(pane(page)).toContainText("add a ## Heading to grow the tree", { ignoreCase: true });
  });

  test("the pane can be hidden, and stays hidden after a reload", async ({ page }) => {
    const id = await seedNote(uniqueTitle("Toggle map"), "# Toggle\n\n## One\n");
    ids.push(id);
    await page.goto(`/vault/${id}`);
    await editableEditor(page);
    await expect(pane(page)).toBeVisible();

    const editorWidth = () => page.getByTestId("note-editor").evaluate((el) => el.getBoundingClientRect().width);
    const split = await editorWidth();

    await page.getByRole("button", { name: "Hide mindmap" }).click();
    await expect(pane(page)).toHaveCount(0);
    await expect.poll(editorWidth).toBeGreaterThan(split + 100);

    await page.reload();
    await editableEditor(page);
    await expect(pane(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show mindmap" })).toHaveAttribute("aria-pressed", "false");

    await page.getByRole("button", { name: "Show mindmap" }).click();
    await expect(pane(page)).toBeVisible();
  });

  test("with a stored concept map, the live heading tree is still the default", async ({ page }) => {
    const title = uniqueTitle("Concept live");
    const markdown = `# ${title}\n\n## Heading Only\n`;
    const id = await seedNote(title, markdown, fakeMindmap(title, [{ label: "Stored Theme", children: ["Stored Child"] }]));
    ids.push(id);
    // The note moves on after its map was built: the stored hash no longer
    // matches, so the server reads the map as stale.
    await serviceRest(`documents?id=eq.${id}`, {
      method: "PATCH",
      body: { markdown: `${markdown}\nWritten after the map.\n` },
      prefer: "return=minimal",
    });
    await page.goto(`/vault/${id}`);
    await editableEditor(page);

    await expect(pane(page).getByRole("tab", { name: "Headings" })).toHaveAttribute("aria-selected", "true");
    await expect(outline(page)).toContainText("Heading Only");
    await expect(outline(page)).not.toContainText("Stored Theme");

    await pane(page).getByRole("tab", { name: "Concept map" }).click();
    await expect(outline(page)).toContainText("Stored Theme");
    await expect(outline(page)).toContainText("Stored Child");
    await expect(pane(page).getByText("Note has changed")).toBeVisible();
    await expect(pane(page).getByRole("button", { name: "Rebuild mindmap" })).toBeVisible();
  });

  test("a note without a stored map has nothing to switch to", async ({ page }) => {
    const id = await seedNote(uniqueTitle("No concept"), "# No concept\n\n## A\n");
    ids.push(id);
    await page.goto(`/vault/${id}`);
    await expect(pane(page)).toBeVisible();
    await expect(pane(page).getByRole("tab", { name: "Concept map" })).toHaveCount(0);
  });
});
