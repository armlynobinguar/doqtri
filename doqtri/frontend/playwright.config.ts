import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

// The tests seed and clean up notes directly, which needs the service role key.
dotenv.config({ path: ".env.local", quiet: true });

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
  ],

  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
