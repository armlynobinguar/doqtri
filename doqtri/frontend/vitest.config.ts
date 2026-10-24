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
    // under app/api mock Supabase and exercise a handler's answers.
    include: ["lib/**/*.test.ts", "app/api/**/*.test.ts"],
    environment: "node",
  },
});
