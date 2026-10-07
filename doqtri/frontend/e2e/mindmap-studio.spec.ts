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

    // Found by its fill, since the view is framed on the whole map, not on it.
    // Retried while the layout may still be moving under the pointer.
    await expect
      .poll(
        async () => {
          const point = await fillPoint(page, root);
          if (point) await page.mouse.click(point.x, point.y);
          return page.getByRole("heading", { name: "Selected" }).isVisible();
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    await expect(page.getByText(title, { exact: true }).last()).toBeVisible();
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

/** A heading-only note that outlines to 1 + 12 + 120 + 1,080 = 1,213 nodes. */
function hugeOutline(title: string): string {
  const lines = [`# ${title}`, ""];
  for (let a = 0; a < 12; a++) {
    lines.push(`# Area ${a}`);
    for (let b = 0; b < 10; b++) {
      lines.push(`## Area ${a} part ${b}`);
      for (let c = 0; c < 9; c++) lines.push(`### Item ${a}.${b}.${c}`);
    }
  }
  return lines.join("\n") + "\n";
}

test.describe("large mindmaps", () => {
  test.describe.configure({ timeout: 120_000 });
  let docId: string;

  test.beforeEach(async () => {
    const title = uniqueTitle("Huge");
    // No stored map: the heading outline has no per-level cap, so this is the
    // way a real note gets a map this big.
    docId = await seedNote(title, hugeOutline(title));
  });

  test.afterEach(async () => {
    await deleteNote(docId);
  });

  test("asks before drawing, and the overview draws a slice", async ({ page }) => {
    await page.goto(`/vault/${docId}/mindmap`);
    await expect(page.getByRole("heading", { name: "Large mindmap — render it?" })).toBeVisible();
    // Nothing is drawn until the viewer chooses.
    await expect(page.locator("canvas")).toHaveCount(0);

    await page.getByRole("button", { name: /^Overview:/ }).click();
    await expect(page.getByText("Building mindmap…")).toBeVisible();
    await expect(page.getByText("Building mindmap…")).toBeHidden({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /^Showing \d+ of 1214 nodes/ })).toBeVisible();
  });

  test("zoomed out, deeper levels wait until zoomed in", async ({ page }) => {
    /** Canvas pixels that are not the plain backdrop: roughly, how much is drawn. */
    const drawn = () =>
      page.locator("canvas").first().evaluate((el: HTMLCanvasElement) => {
        const { data } = el.getContext("2d")!.getImageData(0, 0, el.width, el.height);
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (Math.abs(data[i] - 0x08) + Math.abs(data[i + 1] - 0x09) + Math.abs(data[i + 2] - 0x0b) > 24) count++;
        }
        return count;
      });

    await page.goto(`/vault/${docId}/mindmap`);
    await page.getByRole("button", { name: /^Render all/ }).click();
    await expect(page.getByText("Building mindmap…")).toBeHidden({ timeout: 60_000 });
    await page.waitForTimeout(1000);
    const revealing = await drawn();

    await page.getByRole("button", { name: "Customize" }).click();
    await page.getByRole("button", { name: "Scene", exact: true }).click();
    await page.getByRole("switch", { name: "Reveal detail as you zoom" }).click();
    await page.getByRole("button", { name: "Close" }).click();
    await page.waitForTimeout(500);
    const everything = await drawn();

    // At the fitted zoom the 1,080 leaves are unreadable, so they are not drawn.
    expect(revealing).toBeLessThan(everything * 0.7);
  });

  test("rendering everything settles and keeps the page responsive", async ({ page }) => {
    await page.goto(`/vault/${docId}/mindmap`);
    await page.getByRole("button", { name: /^Render all:/ }).click();
    await expect(page.getByText("Building mindmap…")).toBeVisible();

    // The main thread must keep answering while the layout runs: the old
    // every-pair overlap pass froze it for tens of seconds at this size.
    let worstGap = 0;
    const started = Date.now();
    while (await page.getByText("Building mindmap…").isVisible()) {
      const before = Date.now();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      worstGap = Math.max(worstGap, Date.now() - before);
      expect(Date.now() - started, "layout never settled").toBeLessThan(60_000);
    }
    console.log(`settled in ${Date.now() - started}ms, worst frame ${worstGap}ms`);
    expect(worstGap).toBeLessThan(500);
    await expect(page.getByRole("button", { name: /^Showing all 1214 nodes/ })).toBeVisible();
  });
});

/**
 * How many canvas pixels are bright — essentially label text and outlines.
 * Dimming the unrelated nodes takes most of theirs below the threshold, while
 * the dark background, which dominates any plain sum, does not count at all.
 */
async function canvasBrightness(page: Page): Promise<number> {
  return page.locator("canvas").first().evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("2d");
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    let bright = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] + data[i + 1] + data[i + 2] > 300) bright++;
    }
    return bright;
  });
}

/**
 * A point on a theme pill, in page coordinates, found by its fill colour
 * (#1a1b20, the default look's theme fill). Themes are the first ring out from
 * the root, so focusing one lights a branch, not the whole map.
 */
function themePoint(page: Page) {
  return fillPoint(page, [0x1a, 0x1b, 0x20]);
}

/** A point inside the first pill filled exactly `rgb`, in page coordinates. */
async function fillPoint(page: Page, rgb: [number, number, number]): Promise<{ x: number; y: number } | null> {
  const canvas = page.locator("canvas").first();
  const hit = await canvas.evaluate((el: HTMLCanvasElement, [r, g, b]) => {
    const ctx = el.getContext("2d");
    if (!ctx) return null;
    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    const scale = el.width / el.clientWidth;
    // A solid run of fill, not a stray antialiased pixel on another pill's edge.
    const RUN = 12;
    for (let y = 0; y < el.height; y++) {
      let run = 0;
      for (let x = 0; x < el.width; x++) {
        const i = (y * el.width + x) * 4;
        if (data[i] === r && data[i + 1] === g && data[i + 2] === b) {
          if (++run === RUN) return { x: (x - RUN / 2) / scale, y: y / scale };
        } else {
          run = 0;
        }
      }
    }
    return null;
  }, rgb);
  const box = await canvas.boundingBox();
  return hit && box ? { x: box.x + hit.x, y: box.y + hit.y + 2 } : null;
}

test.describe("focus on hover", () => {
  let docId: string;

  test.beforeEach(async ({ page }) => {
    const title = uniqueTitle("Focus");
    docId = await seedNote(
      title,
      `# ${title}\n\nBranches.\n`,
      fakeMindmap(title, [
        { label: "Alpha", children: ["A one", "A two"] },
        { label: "Beta", children: ["B one", "B two"] },
        { label: "Gamma", children: ["C one", "C two"] },
        { label: "Delta", children: ["D one", "D two"] },
      ]),
    );
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

  async function settledThemePoint(page: Page) {
    await page.goto(`/vault/${docId}/mindmap`);
    let point: { x: number; y: number } | null = null;
    await expect
      .poll(async () => (point = await themePoint(page)), { timeout: 20_000 })
      .not.toBeNull();
    // Measure only once the layout and its zoom-to-fit have stopped moving:
    // two readings in a row, half a second apart, that agree.
    let last = -1;
    await expect
      .poll(
        async () => {
          await page.waitForTimeout(500);
          const now = await canvasBrightness(page);
          const stable = now === last;
          last = now;
          return stable;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    return (await themePoint(page)) ?? point!;
  }

  test("hovering a node dims the rest, and leaving restores it", async ({ page }) => {
    const point = await settledThemePoint(page);
    const before = await canvasBrightness(page);

    await page.mouse.move(point.x, point.y);
    await expect.poll(() => canvasBrightness(page)).toBeLessThan(before * 0.9);

    const box = (await page.locator("canvas").first().boundingBox())!;
    await page.mouse.move(box.x + 8, box.y + box.height - 8);
    await expect.poll(() => canvasBrightness(page)).toBeGreaterThan(before * 0.97);
  });

  test("a locked highlight survives the pointer leaving, until unlocked", async ({ page }) => {
    const point = await settledThemePoint(page);
    const before = await canvasBrightness(page);

    await page.mouse.move(point.x, point.y);
    const lock = page.getByRole("button", { name: "Lock highlight" });
    await expect(lock).toBeVisible();
    await lock.click();

    const unlock = page.getByRole("button", { name: /^Unlock the highlight on / });
    await expect(unlock).toBeVisible();

    // Away from every node: a plain hover would fade back by now.
    const box = (await page.locator("canvas").first().boundingBox())!;
    await page.mouse.move(box.x + 8, box.y + box.height - 8);
    await page.waitForTimeout(600);
    expect(await canvasBrightness(page)).toBeLessThan(before * 0.9);

    await unlock.click();
    await expect(unlock).toBeHidden();
    await expect.poll(() => canvasBrightness(page)).toBeGreaterThan(before * 0.97);
  });

  test("the studio switch turns it off", async ({ page }) => {
    const point = await settledThemePoint(page);
    await page.getByRole("button", { name: "Customize" }).click();
    await page.getByRole("button", { name: "Scene", exact: true }).click();
    await page.getByRole("switch").first().click();
    await page.getByRole("button", { name: "Close" }).click();

    const before = await canvasBrightness(page);
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(600);
    expect(await canvasBrightness(page)).toBeGreaterThan(before * 0.97);
  });

  test.describe("on touch", () => {
    test.use({ hasTouch: true });

    test("holding a node focuses it without opening the note", async ({ page }) => {
      const point = await settledThemePoint(page);
      const url = page.url();
      const before = await canvasBrightness(page);

      const cdp = await page.context().newCDPSession(page);
      const touch = (type: "touchStart" | "touchEnd", points: { x: number; y: number }[]) =>
        cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });

      await touch("touchStart", [point]);
      await page.waitForTimeout(700);
      await touch("touchEnd", []);

      // Dimmed, and still dimmed after the finger lifts.
      await expect.poll(() => canvasBrightness(page)).toBeLessThan(before * 0.9);
      await page.waitForTimeout(500);
      expect(await canvasBrightness(page)).toBeLessThan(before * 0.9);
      expect(page.url()).toBe(url);

      // A tap on empty space lets go.
      const box = (await page.locator("canvas").first().boundingBox())!;
      const empty = { x: box.x + 8, y: box.y + box.height - 8 };
      await touch("touchStart", [empty]);
      await touch("touchEnd", []);
      await expect.poll(() => canvasBrightness(page)).toBeGreaterThan(before * 0.97);
    });
  });
});
