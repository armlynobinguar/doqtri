import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import {
  E2E_DOQTRI_ORIGIN,
  QDIT_STUB_CLIENT_ID,
  QDIT_STUB_CLIENT_SECRET,
  QDIT_STUB_ORIGIN,
  QDIT_STUB_PORT,
  qditStubEnv,
} from "./e2e/qdit-stub/config";
import { OPENAI_STUB_ORIGIN, openaiStubEnv, openaiStubServerEnv } from "./e2e/openai-stub/config";
import { E2E_ADMIN_WALLET } from "./e2e/admin-wallet";

// The tests seed and clean up notes directly, which needs the service role key.
// Earlier files win — dotenv keeps the first value it sees. `.env.e2e` is the
// staging branch's keys, written by the release console's
// `staging.mjs db --app doqtri` and deleted by its `down` (DOQ-16). The dev
// server below inherits these values, and they beat its own .env files.
dotenv.config({ path: ".env.e2e", quiet: true });
// The testnet project's extra settings (DOQ-19, e2e/chain/README.md), only
// when `npm run test:e2e:chain` asks for them. They reach the dev server too.
if (process.env.E2E_CHAIN === "1") {
  dotenv.config({ path: ".env.chain", quiet: true });
  // On-chain workspace roles, and a cron key so the spec can run the chain
  // job queue itself. Neither is a secret on a throwaway e2e run.
  process.env.NEXT_PUBLIC_REGISTRY_EDITORS ||= "1";
  process.env.CRON_SECRET ||= "e2e-chain-only-cron-secret";
}
dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ path: ".env", quiet: true });

const BASE_URL = E2E_DOQTRI_ORIGIN;

export default defineConfig({
  testDir: "./e2e",
  // Tests share one signed-in user and mutate note content, so serial.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // A live terminal view locally (e2e/progress-reporter.ts); the plain list in CI.
  reporter: process.env.CI ? [["list"]] : [["./e2e/progress-reporter.ts"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // Desktop by default; the `mobile` project covers the compact layout.
    viewport: { width: 1440, height: 900 },
  },

  projects: [
    // Signs in through the real login form and saves the session for reuse.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      // *.test.ts under e2e/ are Vitest files (the qdit stub's own check).
      // e2e/qdit-live/ runs against staging, from playwright.qdit-live.config.ts.
      // e2e/chain/ spends testnet XLM and runs only from `npm run test:e2e:chain`.
      testIgnore: [/mobile\.spec\.ts/, /\.test\.ts$/, /qdit-live\//, /chain\//],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },
    /*
     * On-chain flows on Stellar testnet (DOQ-19): passkey wallets, anchoring,
     * the audit page, the marketplace and on-chain workspaces. Slow and
     * dependent on public RPC, so never part of `test:e2e`; run it with
     * `npm run test:e2e:chain`. Its own setup signs nobody in: each spec makes
     * its own email accounts and passkey wallets.
     */
    {
      name: "chain",
      testDir: "./e2e/chain",
      testMatch: /.*\.chain\.ts/,
      timeout: 300_000,
      expect: { timeout: 30_000 },
      // A failed write would leave later steps with nothing to act on.
      retries: 0,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    // The vault's compact layout. A Chromium phone profile, so it runs on the
    // same installed browser as the desktop suite.
    {
      name: "mobile",
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["Pixel 7"],
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

  webServer: [
    /*
     * A stand-in qdit (e2e/qdit-stub/server.mts) built from
     * docs/integration/CONTRACT.md, so the qdit specs run without qdit's
     * repository, which doqtri does not own (DOQ-16).
     */
    {
      command: "node e2e/qdit-stub/server.mts",
      url: `${QDIT_STUB_ORIGIN}/__stub/health`,
      reuseExistingServer: true,
      timeout: 15_000,
      env: {
        QDIT_STUB_PORT: String(QDIT_STUB_PORT),
        QDIT_STUB_CLIENT_ID,
        QDIT_STUB_CLIENT_SECRET,
        QDIT_STUB_DOQTRI_ORIGIN: E2E_DOQTRI_ORIGIN,
      },
    },
    /*
     * A stand-in OpenAI (e2e/openai-stub/server.mts), so upload, Regenerate
     * and Build mindmap run without spending real tokens (DOQ-18).
     */
    {
      command: "node e2e/openai-stub/server.mts",
      url: `${OPENAI_STUB_ORIGIN}/__stub/health`,
      reuseExistingServer: true,
      timeout: 15_000,
      env: openaiStubServerEnv(),
    },
    {
      command: "npm run dev",
      url: BASE_URL,
      // A dev server started by hand keeps its own environment, which may
      // name another Supabase project or a real qdit. Reusing one is opt-in
      // (E2E_REUSE_DEV_SERVER=1); otherwise a busy :3000 stops the run.
      reuseExistingServer: process.env.E2E_REUSE_DEV_SERVER === "1",
      timeout: 120_000,
      env: {
        ...qditStubEnv(),
        // Replaces any real OPENAI_API_KEY with the stub's fake one.
        ...openaiStubEnv(),
        // The e2e wallet is the only admin, for the /admin specs.
        DOQTRI_ADMINS: E2E_ADMIN_WALLET,
      },
    },
  ],
});
