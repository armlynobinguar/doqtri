import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // Next resolves this marker itself; outside its bundler it is an empty module.
      "server-only": "next/dist/compiled/server-only/empty.js",
    },
  },
  test: {
    // lib/ is pure and deterministic — that is the whole point of deriving the
    // graph from markdown, and it is what these tests pin down. Route tests
    // under app/api mock Supabase and exercise a handler's answers. Component
    // tests under components/, and the public audit page's under app/d,
    // render to static markup (no DOM). The load test's pure parts are tested
    // under scripts/; its network runs (*.load.ts) have their own config.
    include: [
      "lib/**/*.test.ts",
      "app/api/**/*.test.ts",
      "app/d/**/*.test.ts",
      // The legal pages' gate, with the sitemap and robots.txt beside them.
      "app/*.test.ts",
      "components/**/*.test.ts",
      "scripts/**/*.test.ts",
      // The e2e qdit stub, checked against doqtri's real client (no network beyond localhost).
      "e2e/**/*.test.ts",
    ],
    environment: "node",
  },
});
