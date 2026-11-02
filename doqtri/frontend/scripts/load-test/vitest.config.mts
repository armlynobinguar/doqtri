/**
 * Runs the load-test files (*.load.ts) and nothing else. The default config
 * (../../vitest.config.ts) never collects them, so `npm test` stays offline;
 * these need a deployment, Supabase keys or testnet, and run only on purpose:
 *
 *   npx vitest run --config scripts/load-test/vitest.config.mts paid-writes
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root,
  resolve: { alias: { "@": root } },
  test: {
    include: ["scripts/load-test/*.load.ts"],
    environment: "node",
    // Setting up 30 wallets on testnet takes minutes, not seconds.
    testTimeout: 60 * 60_000,
    // Show progress as it happens instead of after the run.
    disableConsoleIntercept: true,
  },
});
