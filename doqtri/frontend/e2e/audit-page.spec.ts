import { expect, test } from "@playwright/test";

// The audit page is for reviewers without an account: no stored session.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("public audit page", () => {
  test("opens logged out and shows the not-anchored state for an unknown id", async ({
    page,
  }) => {
    const unknown = crypto.randomUUID();
    await page.goto(`/d/${unknown}`);

    // Not bounced to the landing page by the auth proxy.
    await expect(page).toHaveURL(new RegExp(`/d/${unknown}$`));
    await expect(page.getByRole("heading", { name: "Not anchored" })).toBeVisible();
    await expect(page.getByText(unknown)).toBeVisible();
  });

  test("rejects a malformed id without querying", async ({ page }) => {
    await page.goto("/d/has%20a%20space");
    await expect(
      page.getByRole("heading", { name: "Not a Doqtri document id" }),
    ).toBeVisible();
  });
});
