import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

// The tests seed and clean up notes directly, which needs the service role key.
// `.env.local` wins where both exist — dotenv keeps the first value it sees.
dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ path: ".env", quiet: true });

const BASE_URL = "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  // Tests share one signed-in user and mutate note content, so serial.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // The app is dark-only and desktop-only; no mobile layout exists in v1.
    viewport: { width: 1440, height: 900 },
  },

  projects: [
    // Signs in through the real login form and saves the session for reuse.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },
    /*
     * Demo-video screenshots, not tests. Opt-in via --project=shots so a normal
     * e2e run neither pays the capture time nor rewrites committed images.
     * Wider and 2x scaled: the video is 1920x1080 and pans into these.
     */
    {
      name: "shots",
      testDir: "./capture",
      // Not a *.spec.ts, so the default testMatch would silently find nothing.
      testMatch: /.*\.capture\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1600, height: 900 },
        deviceScaleFactor: 2,
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },
    /*
     * The recorded product walkthrough. No `setup` dependency and no shared
     * storageState: it signs in through the real Connect wallet flow against a
     * stand-in Freighter, because that flow is the first thing the video shows.
     */
    {
      name: "walkthrough",
      testDir: "./capture",
      testMatch: /walkthrough\.capture\.ts/,
      timeout: 300_000,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1920, height: 1080 },
        // A global beat between actions, so the recording is watchable.
        launchOptions: { slowMo: 260 },
      },
    },
  ],

  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
