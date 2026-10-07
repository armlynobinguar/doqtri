import { test, expect, type Page } from "@playwright/test";
import { deleteNote, fakeMindmap, seedNote, uniqueTitle } from "./helpers";

/** Whether any pixel on the 2D canvas is within `tolerance` of `rgb`. */
async function canvasHasColor(page: Page, rgb: [number, number, number], tolerance = 6): Promise<boolean> {
  return page.locator("canvas").first().evaluate(
    (el: HTMLCanvasElement, [target, tol]) => {
      const ctx = el.getContext("2d");
      if (!ctx) return false;
      const { data } = ctx.getImageData(0, 0, el.width, el.height);
      for (let i = 0; i < data.length; i += 4) {
        if (
          Math.abs(data[i] - target[0]) <= tol &&
          Math.abs(data[i + 1] - target[1]) <= tol &&
          Math.abs(data[i + 2] - target[2]) <= tol
        ) {
          return true;
        }
      }
      return false;
    },
    [rgb, tolerance] as const,
  );
}

test.describe("mindmap studio", () => {
  let docId: string;
  let title: string;

  test.beforeEach(async ({ page }) => {
    title = uniqueTitle("Studio");
    docId = await seedNote(
      title,
      `# ${title}\n\nA note to style.\n`,
      fakeMindmap(title, [
        { label: "Consensus Design", children: ["Finality", "Validator Set"] },
        { label: "Fee Market", children: ["Base Fee"] },
        { label: "Storage" },
      ]),
    );
    // Styles persist per browser; start every test from the default look.
    // Once per tab, so a reload inside a test still sees what it saved.
    await page.addInitScript(() => {
      if (sessionStorage.getItem("studio-reset")) return;
      sessionStorage.setItem("studio-reset", "1");
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("mindmap-style:")) localStorage.removeItem(key);
      }
    });
  });

  test.afterEach(async () => {
    await deleteNote(docId);
  });

  test("a preset restyles the canvas and survives a reload", async ({ page }) => {
    await page.goto(`/vault/${docId}/mindmap`);
    await page.getByRole("button", { name: "Customize" }).click();
    await expect(page.getByRole("heading", { name: "Mindmap studio" })).toBeVisible();

    await page.getByRole("button", { name: "Paper" }).click();
    // Paper's background is #f5f0e6, nothing like the default near-black.
    await expect.poll(() => canvasHasColor(page, [0xf5, 0xf0, 0xe6]), { timeout: 15_000 }).toBe(true);

    await page.reload();
    await expect.poll(() => canvasHasColor(page, [0xf5, 0xf0, 0xe6]), { timeout: 15_000 }).toBe(true);
  });

  test("undo puts the previous look back", async ({ page }) => {
    await page.goto(`/vault/${docId}/mindmap`);
    await page.getByRole("button", { name: "Customize" }).click();
    await page.getByRole("button", { name: "Paper" }).click();
    await expect.poll(() => canvasHasColor(page, [0xf5, 0xf0, 0xe6]), { timeout: 15_000 }).toBe(true);

    await page.getByRole("button", { name: "Undo (⌘Z)" }).click();
    // #08090b is the default background.
    await expect.poll(() => canvasHasColor(page, [0x08, 0x09, 0x0b], 1), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => canvasHasColor(page, [0xf5, 0xf0, 0xe6]), { timeout: 5_000 }).toBe(false);
  });

  test("the 3D view mounts a WebGL scene", async ({ page }) => {
    await page.goto(`/vault/${docId}/mindmap`);
    await page.getByRole("button", { name: "Switch to 3D" }).click();
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Array.from(document.querySelectorAll("canvas")).some(
              (canvas) => canvas.getContext("webgl2") !== null || canvas.getContext("webgl") !== null,
            ),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect(page.getByRole("button", { name: "Switch to 2D" })).toBeVisible();
  });

  test("a hidden node is listed and can be shown again on its own", async ({ page }) => {
    await page.goto(`/vault/${docId}/mindmap`);
    // #24252c is the root pill's fill in the default look.
    const root: [number, number, number] = [0x24, 0x25, 0x2c];
    await expect.poll(() => canvasHasColor(page, root, 0), { timeout: 15_000 }).toBe(true);

    await page.getByRole("button", { name: "Customize" }).click();
    await page.getByRole("button", { name: "Node", exact: true }).click();

    // The radial layout puts the root at the centre of the view.
    const box = (await page.locator("canvas").first().boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByRole("button", { name: "Hide node" }).click();

    await expect(page.getByRole("heading", { name: "Hidden (1)" })).toBeVisible();
    await expect.poll(() => canvasHasColor(page, root, 0), { timeout: 5_000 }).toBe(false);

    await page.getByRole("button", { name: `Show ${title}` }).click();
    await expect(page.getByRole("heading", { name: /^Hidden/ })).toHaveCount(0);
    await expect.poll(() => canvasHasColor(page, root, 0), { timeout: 5_000 }).toBe(true);
  });

  test("clicking a node in 3D selects it without a page error", async ({ page }) => {
    // 3d-force-graph ends every node click with a synthetic pointer-up that
    // OrbitControls used to choke on.
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`/vault/${docId}/mindmap`);
    await page.getByRole("button", { name: "Switch to 3D" }).click();
    await page.getByRole("button", { name: "Customize" }).click();
    await page.getByRole("button", { name: "Node", exact: true }).click();

    // The root sits at the origin, which the camera frames at the centre.
    const canvas = page.locator("canvas").first();
    await expect
      .poll(
        async () => {
          const box = await canvas.boundingBox();
          if (!box) return false;
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          return page.getByRole("button", { name: "Hide node" }).isVisible();
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    await page.getByRole("button", { name: "🚀" }).click();
    expect(errors).toEqual([]);
  });

  test("a snapshot downloads a PNG at the chosen size", async ({ page }) => {
    await page.goto(`/vault/${docId}/mindmap`);
    // Give the layout time to settle before capturing.
    await expect.poll(() => canvasHasColor(page, [0xf4, 0xf5, 0xf7], 30), { timeout: 15_000 }).toBe(true);

    await page.getByRole("button", { name: "Snapshot" }).click();
    await page.getByRole("button", { name: "1:1" }).click();
    await page.getByRole("button", { name: "HD" }).click();
    await expect(page.getByText("1920 × 1920px")).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.png$/);

    const path = await download.path();
    const { readFileSync } = await import("node:fs");
    const png = readFileSync(path);
    // PNG signature, then the IHDR width and height.
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(1920);
    expect(png.readUInt32BE(20)).toBe(1920);
  });
});
