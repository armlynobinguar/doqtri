import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import { LIVE_DOQTRI_URL, assertLiveTargets } from "./e2e/qdit-live/config";

/*
 * The qdit-live suite (DOQ-20): deployed doqtri staging against deployed qdit
 * staging. Its own config, not a project of playwright.config.ts, because that
 * config starts the qdit stub and a local dev server for every project, and
 * this suite must use neither.
 *
 * `.env.qdit-live` (gitignored) holds the staging branch's keys and the qdit
 * test account; e2e/qdit-live/README.md lists what goes in it. Nothing falls
 * back to .env.local, which names the e2e branch, not staging.
 */
dotenv.config({ path: ".env.qdit-live", quiet: true });

// Fail before a browser starts if either end is not staging.
assertLiveTargets();

export default defineConfig({
  testDir: "./e2e/qdit-live",
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"]] : [["./e2e/progress-reporter.ts"]],
  // Real network both ways, with a Vercel cold start possible on either side.
  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: LIVE_DOQTRI_URL,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },

  projects: [
    { name: "qdit-live-setup", testMatch: /live\.setup\.ts/ },
    {
      name: "qdit-live",
      testMatch: /qdit-live\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        storageState: "e2e/.auth/qdit-live-user.json",
      },
      dependencies: ["qdit-live-setup"],
    },
  ],
});
