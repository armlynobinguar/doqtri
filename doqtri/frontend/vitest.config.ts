import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    // lib/ is pure and deterministic — that is the whole point of deriving the
    // graph from markdown, and it is what these tests pin down. Route tests
    // under app/api mock Supabase and exercise a handler's answers. Component
    // tests under components/, and the public audit page's under app/d,
    // render to static markup (no DOM).
    include: ["lib/**/*.test.ts", "app/api/**/*.test.ts", "app/d/**/*.test.ts", "components/**/*.test.ts"],
    environment: "node",
  },
});
