import { test, expect } from "@playwright/test";
import { deleteNote, seedNote, uniqueTitle } from "./helpers";

test.describe("derived views", () => {
  let hubId: string;
  let spokeId: string;
  let hubTitle: string;
  let spokeTitle: string;

  test.beforeEach(async () => {
    hubTitle = uniqueTitle("Hub");
    spokeTitle = uniqueTitle("Spoke");
    // The hub links to a real note and to a target that does not exist, so the
    // graph must show one resolved edge and one ghost.
    hubId = await seedNote(
      hubTitle,
      `# ${hubTitle}\n\n## Links\n\nSee [[${spokeTitle}]] and [[Nonexistent Target]].\n`,
    );
    spokeId = await seedNote(spokeTitle, `# ${spokeTitle}\n\nLeaf note.\n`);
  });

  test.afterEach(async () => {
    await deleteNote(hubId);
    await deleteNote(spokeId);
  });

  test("the force graph paints to canvas", async ({ page }) => {
    await page.goto(`/vault/${hubId}`);

    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible();

    // A mounted-but-blank canvas would still pass a visibility check, so assert
    // that pixels were actually drawn in something other than the background.
    await expect
      .poll(
        async () =>
          canvas.evaluate((el: HTMLCanvasElement) => {
            const ctx = el.getContext("2d");
            if (!ctx) return 0;
            const { data } = ctx.getImageData(0, 0, el.width, el.height);
            const seen = new Set<string>();
            for (let i = 0; i < data.length; i += 4) {
              if (data[i + 3] === 0) continue;
              seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
            }
            return seen.size;
          }),
        { timeout: 20_000, message: "graph canvas never drew more than one color" },
      )
      .toBeGreaterThan(2);
  });

  test("backlinks list the notes pointing here", async ({ page }) => {
    await page.goto(`/vault/${spokeId}`);

    // Scoped to the backlinks panel: the explorer also has a link to the hub.
    const backlink = page
      .getByTestId("backlinks")
      .getByRole("link", { name: hubTitle });
    await expect(backlink).toBeVisible();

    await backlink.click();
    await page.waitForURL(`**/vault/${hubId}`);
  });

  test("the mindmap tab renders the heading tree", async ({ page }) => {
    await page.goto(`/vault/${hubId}`);
    await page.getByRole("tab", { name: "Mindmap" }).click();

    // Scoped to the panel: the editor's live preview renders these words too.
    const mindmap = page.getByTestId("mindmap");
    /*
     * The root is the document title, rendered as the panel's only <p>. The
     * body's `# Hub` heading also becomes a child node with the same label, so
     * match the root element specifically rather than by text.
     */
    await expect(mindmap.getByRole("paragraph")).toHaveText(hubTitle);
    await expect(mindmap.getByText("Links", { exact: true })).toBeVisible();
  });

  test("editing a heading updates the mindmap live", async ({ page }) => {
    await page.goto(`/vault/${hubId}`);
    await page.getByRole("tab", { name: "Mindmap" }).click();
    const mindmap = page.getByTestId("mindmap");
    await expect(mindmap.getByText("Links", { exact: true })).toBeVisible();

    const textarea = page.locator("textarea.w-md-editor-text-input");
    await expect(textarea).toBeVisible();
    await textarea.click();
    await textarea.press("ControlOrMeta+a");
    await textarea.fill(`# ${hubTitle}\n\n## Renamed Section\n\n### Nested Child\n`);

    // The mindmap reads the live editor text, so this needs no save.
    await expect(mindmap.getByText("Renamed Section", { exact: true })).toBeVisible();
    await expect(mindmap.getByText("Nested Child", { exact: true })).toBeVisible();
    await expect(mindmap.getByText("Links", { exact: true })).toBeHidden();
  });

  test("a new [[link]] adds a node to the graph", async ({ page }) => {
    await page.goto(`/vault/${hubId}`);

    const countNodes = () =>
      page.locator("canvas").first().evaluate((el: HTMLCanvasElement) => {
        const ctx = el.getContext("2d");
        if (!ctx) return 0;
        const { data } = ctx.getImageData(0, 0, el.width, el.height);
        let accent = 0;
        // #4d9dff resolved-node fill
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] === 0x4d && data[i + 1] === 0x9d && data[i + 2] === 0xff) accent += 1;
        }
        return accent;
      });

    await expect.poll(countNodes, { timeout: 20_000 }).toBeGreaterThan(0);
    const before = await countNodes();

    const textarea = page.locator("textarea.w-md-editor-text-input");
    await textarea.click();
    await textarea.press("ControlOrMeta+a");
    await textarea.fill(
      `# ${hubTitle}\n\nSee [[${spokeTitle}]], [[Nonexistent Target]], [[Another Ghost]], [[Third Ghost]].\n`,
    );

    // Graph input is debounced, so this asserts the settled value flows through.
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });
    await expect.poll(countNodes, { timeout: 20_000 }).not.toBe(before);
  });
});
