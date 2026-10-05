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

  test("the ribbon opens the full-pane graph", async ({ page }) => {
    await page.goto(`/vault/${hubId}`);
    await page.getByRole("button", { name: "Graph view" }).click();

    await page.waitForURL("**/vault/graph");
    await expect(page.getByRole("heading", { name: "Graph view" })).toBeVisible();
    // The hub's [[Nonexistent Target]] guarantees at least one ghost.
    await expect(page.getByText(/^\d+ unresolved$/)).toBeVisible();
    await expect(page.locator("canvas").first()).toBeVisible();
  });

  test("graph nodes stay clickable when canvas readback is perturbed", async ({
    page,
  }) => {
    // Brave Shields and similar anti-fingerprinting perturb canvas readback.
    // force-graph's own hit-testing reads a single pixel to find the node under
    // the pointer, so emulate the perturbation on exactly those reads.
    await page.addInitScript(() => {
      const original = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function (
        this: CanvasRenderingContext2D,
        ...args: Parameters<typeof original>
      ) {
        const data = original.apply(this, args);
        if (data.width === 1 && data.height === 1) data.data[2] ^= 1;
        return data;
      } as typeof original;
    });

    await page.goto(`/vault/${spokeId}`);
    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible();
    await page.waitForTimeout(4000); // let the layout settle

    // A resolved note's dot, found by its fill colour (#4a9df0).
    const dot = await canvas.evaluate((el: HTMLCanvasElement) => {
      const ctx = el.getContext("2d")!;
      const { data, width, height } = ctx.getImageData(0, 0, el.width, el.height);
      const scale = el.width / el.getBoundingClientRect().width;
      const hits: [number, number][] = [];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const near = (v: number, t: number) => Math.abs(v - t) < 12;
          if (near(data[i], 0x4a) && near(data[i + 1], 0x9d) && near(data[i + 2], 0xf0)) {
            hits.push([x, y]);
          }
        }
      }
      if (hits.length === 0) return null;
      // Centroid of the pixels around the first match: one dot, not all of them.
      const [fx, fy] = hits[0];
      const mine = hits.filter(([x, y]) => Math.hypot(x - fx, y - fy) < 10 * scale);
      const cx = mine.reduce((a, [x]) => a + x, 0) / mine.length;
      const cy = mine.reduce((a, [, y]) => a + y, 0) / mine.length;
      return { x: cx / scale, y: cy / scale };
    });
    expect(dot, "no note dot found on the graph canvas").not.toBeNull();

    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + dot!.x, box.y + dot!.y);
    await expect
      .poll(() => canvas.evaluate((el) => el.style.cursor))
      .toBe("pointer");

    await page.mouse.down();
    await page.mouse.up();
    await page.waitForURL(/\/vault\/[0-9a-f-]{36}$/);
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

  // These notes are seeded without a stored concept map, so the panel falls
  // back to the heading tree. The stored-map path is covered in
  // mindmap-views.spec.ts.
  test("the mindmap tab falls back to the heading tree", async ({ page }) => {
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
        // #4a9df0 resolved-node fill
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] === 0x4a && data[i + 1] === 0x9d && data[i + 2] === 0xf0) accent += 1;
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
