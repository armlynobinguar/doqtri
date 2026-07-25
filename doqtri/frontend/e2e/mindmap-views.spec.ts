import { test, expect, type Page } from "@playwright/test";
import { deleteNote, fakeMindmap, seedNote, uniqueTitle } from "./helpers";

/**
 * Counts the distinct opaque colors on the mindmap canvas.
 *
 * A mounted-but-blank canvas passes a visibility check, so the assertion that
 * actually means "a map was drawn" is that several colors appeared — the pills
 * use a different fill, stroke, and text color per depth.
 */
/**
 * Finds the hub pill on the canvas and returns its centre, in canvas pixels.
 *
 * The hub is the one node kind this fixture has exactly one of, which is what
 * makes it usable as a landmark — a document pill would be ambiguous, and after
 * a drag the scan could pick a different one and compare two unrelated nodes.
 *
 * Matches the pill's solid fill rather than its stroke: the stroke is drawn
 * sub-pixel wide and antialiasing blends it away, so it never appears in the
 * image data at an exact colour.
 */
async function findHubPill(page: Page): Promise<{ x: number; y: number } | null> {
  return page.locator("canvas").first().evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("2d");
    if (!ctx) return null;

    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    const hits: { x: number; y: number }[] = [];
    for (let i = 0; i < data.length; i += 4) {
      // #2f2547 — MINDMAP_COLORS.hub.fill
      if (data[i] === 0x2f && data[i + 1] === 0x25 && data[i + 2] === 0x47) {
        const pixel = i / 4;
        hits.push({ x: pixel % el.width, y: Math.floor(pixel / el.width) });
      }
    }
    if (hits.length === 0) return null;

    /*
     * Every hit must belong to one pill, or the centre would be the midpoint
     * between two unrelated nodes. Checked by how completely the hits fill
     * their own bounding box — a single rounded rectangle nearly fills it,
     * whereas two pills apart leave most of the box empty. A pixel threshold
     * would not work here: the view zooms to fit, so a pill's size on screen
     * depends on how many nodes the map has.
     */
    const xs = hits.map((hit) => hit.x);
    const ys = hits.map((hit) => hit.y);
    const width = Math.max(...xs) - Math.min(...xs) + 1;
    const height = Math.max(...ys) - Math.min(...ys) + 1;
    if (hits.length / (width * height) < 0.6) return null;

    return {
      x: hits.reduce((sum, hit) => sum + hit.x, 0) / hits.length,
      y: hits.reduce((sum, hit) => sum + hit.y, 0) / hits.length,
    };
  });
}

async function canvasColors(page: Page): Promise<number> {
  return page.locator("canvas").first().evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("2d");
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    const seen = new Set<string>();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
    return seen.size;
  });
}

test.describe("document mindmap", () => {
  let docId: string;
  let title: string;

  test.beforeEach(async () => {
    title = uniqueTitle("Solo");
    // One note, no [[links]], and prose rather than headings: with only the
    // vault graph and the old heading tree this note had nothing to show.
    docId = await seedNote(
      title,
      `# ${title}\n\nA flat document with no structure to parse.\n`,
      fakeMindmap(title, [
        { label: "Consensus Design", children: ["Finality", "Validator Set"] },
        { label: "Fee Market" },
      ]),
    );
  });

  test.afterEach(async () => {
    await deleteNote(docId);
  });

  test("the panel shows the stored concept map, not the headings", async ({ page }) => {
    await page.goto(`/vault/${docId}`);
    await page.getByRole("tab", { name: "Mindmap" }).click();

    const mindmap = page.getByTestId("mindmap");
    await expect(mindmap.getByText("Consensus Design", { exact: true })).toBeVisible();
    await expect(mindmap.getByText("Validator Set", { exact: true })).toBeVisible();
    // The only heading in the markdown is the title, and it is not a child node
    // here — proof the tree came from the stored map rather than the headings.
    await expect(mindmap.getByRole("paragraph")).toHaveText(title);
  });

  test("a single note draws a full-screen mindmap", async ({ page }) => {
    await page.goto(`/vault/${docId}/mindmap`);

    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByText("· concept mindmap")).toBeVisible();

    await expect
      .poll(() => canvasColors(page), {
        timeout: 20_000,
        message: "mindmap canvas never drew more than one color",
      })
      .toBeGreaterThan(2);
  });

  test("the panel links out to the full mindmap", async ({ page }) => {
    await page.goto(`/vault/${docId}`);
    await page.getByRole("tab", { name: "Mindmap" }).click();
    await page.getByRole("link", { name: "Open full mindmap" }).click();

    await page.waitForURL(`**/vault/${docId}/mindmap`);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  });

  test("a note with no stored map falls back to its headings", async ({ page }) => {
    const plainTitle = uniqueTitle("Plain");
    const plainId = await seedNote(
      plainTitle,
      `# ${plainTitle}\n\n## Only A Heading\n\nProse.\n`,
    );

    try {
      await page.goto(`/vault/${plainId}/mindmap`);
      await expect(page.getByText("· heading outline")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Build mindmap" }),
      ).toBeVisible();
    } finally {
      await deleteNote(plainId);
    }
  });

  test("editing the note marks the stored map as changed", async ({ page }) => {
    await page.goto(`/vault/${docId}`);

    const textarea = page.locator("textarea.w-md-editor-text-input");
    await textarea.click();
    await textarea.press("ControlOrMeta+a");
    await textarea.fill(`# ${title}\n\nCompletely different text.\n`);
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });

    // Staleness is decided on the server from the markdown hash, so the flag
    // only appears once the saved note is read back.
    await page.goto(`/vault/${docId}/mindmap`);
    await expect(page.getByText("· note has changed since this map")).toBeVisible();
    await expect(page.getByRole("button", { name: "Rebuild" })).toBeVisible();
  });
});

test.describe("global mindmap", () => {
  let alphaId: string;
  let betaId: string;
  let alphaTitle: string;
  let betaTitle: string;
  const shared = "Shared Concept";

  test.beforeEach(async () => {
    alphaTitle = uniqueTitle("Alpha");
    betaTitle = uniqueTitle("Beta");

    // Neither note links to the other. They meet only at a concept both
    // mindmaps name, which is what the global view exists to show.
    alphaId = await seedNote(
      alphaTitle,
      `# ${alphaTitle}\n\nFirst note.\n`,
      fakeMindmap(alphaTitle, [{ label: shared }, { label: "Alpha Only" }]),
    );
    betaId = await seedNote(
      betaTitle,
      `# ${betaTitle}\n\nSecond note.\n`,
      fakeMindmap(betaTitle, [{ label: shared }, { label: "Beta Only" }]),
    );
  });

  test.afterEach(async () => {
    await deleteNote(alphaId);
    await deleteNote(betaId);
  });

  test("the ribbon opens the global mindmap", async ({ page }) => {
    await page.goto(`/vault/${alphaId}`);
    await page.getByRole("button", { name: "Global mindmap" }).click();

    await page.waitForURL("**/vault/mindmap");
    await expect(page.getByRole("heading", { name: "Global mindmap" })).toBeVisible();
  });

  test("shared concepts are counted as hubs", async ({ page }) => {
    await page.goto("/vault/mindmap");

    // Both seeded notes reach `shared`, so at least one hub must exist. Other
    // notes in the vault may add more, hence the regex rather than an equality.
    await expect(page.getByText(/^Shared \(\d+\)$/)).toBeVisible();
    await expect(page.getByText(/^Shared \(0\)$/)).toBeHidden();

    await expect
      .poll(() => canvasColors(page), {
        timeout: 20_000,
        message: "global mindmap canvas never drew more than one color",
      })
      .toBeGreaterThan(2);
  });

  test("a dragged node stays where it is dropped", async ({ page }) => {
    await page.goto("/vault/mindmap");

    // Wait for the simulation to settle, or the node would still be drifting
    // under its own forces and the comparison would prove nothing.
    await expect
      .poll(() => canvasColors(page), { timeout: 20_000 })
      .toBeGreaterThan(2);
    await page.waitForTimeout(6000);

    const canvas = (await page.locator("canvas").first().boundingBox())!;
    const before = await findHubPill(page);
    expect(before, "no single hub pill found on the canvas").not.toBeNull();

    const dx = -200;
    const dy = 160;
    await page.mouse.move(canvas.x + before!.x, canvas.y + before!.y);
    await page.mouse.down();
    await page.mouse.move(canvas.x + before!.x + dx, canvas.y + before!.y + dy, {
      steps: 25,
    });
    await page.mouse.up();

    // Long enough that an unpinned node would have sprung back to the layout.
    await page.waitForTimeout(5000);

    const after = await findHubPill(page);
    expect(after).not.toBeNull();
    expect(after!.x - before!.x).toBeCloseTo(dx, -1);
    expect(after!.y - before!.y).toBeCloseTo(dy, -1);
  });

  test("clicking a note node opens that note's mindmap", async ({ page }) => {
    await page.goto("/vault/mindmap");

    // Node positions come out of a force simulation, so a click at a guessed
    // coordinate is flaky. The explorer is the stable route to the same place.
    await page.getByRole("link", { name: alphaTitle }).first().click();
    await page.waitForURL(`**/vault/${alphaId}`);

    await page.getByRole("tab", { name: "Mindmap" }).click();
    await page.getByRole("link", { name: "Open full mindmap" }).click();
    await page.waitForURL(`**/vault/${alphaId}/mindmap`);
  });
});
