import { test, expect, type Page } from "@playwright/test";
import { headingRenameCases } from "./heading-rename-cases";

/** The side panel, apart from the live mindmap pane beside the editor (which has its own tabs). */
function rightPanel(page: Page) {
  return page.getByTestId("right-panel");
}

test.describe("editing the title heading renames the note (DOQ-36)", () => {
  headingRenameCases({
    titleOf: (id) => `[data-note-link="${id}"]`,
    async expectTitle(page, title, old) {
      // The explorer and the editor's tab.
      await expect(page.getByRole("link", { name: title, exact: true }).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("link", { name: old, exact: true })).toHaveCount(0);
      await expect(page.getByRole("tab", { name: title, exact: true })).toBeVisible();
      await expect(page.getByRole("tab", { name: old, exact: true })).toHaveCount(0);
    },
    async expectMindmap(page, title, sections, old) {
      await rightPanel(page).getByRole("tab", { name: "Mindmap" }).click();
      const mindmap = rightPanel(page).getByTestId("mindmap");
      await expect(mindmap.getByRole("paragraph").first()).toHaveText(title);
      // The sections sit right around the root: the heading is folded into it, no lone node.
      await expect(mindmap.locator(":scope > ul > li > span")).toHaveText(sections);
      await expect(mindmap.getByText(old, { exact: true })).toHaveCount(0);
      await expect(mindmap.getByText(title, { exact: true })).toHaveCount(1);
      // The live mindmap beside the editor too.
      const live = page.getByTestId("live-mindmap-outline");
      await expect(live.getByRole("paragraph")).toHaveText(title);
      await expect(live.getByText(old, { exact: true })).toHaveCount(0);
    },
    async expectBacklinks(page, count) {
      await expect(rightPanel(page).getByTestId("backlinks").locator("header")).toContainText(String(count), {
        timeout: 15_000,
      });
    },
  });
});
