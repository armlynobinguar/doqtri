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
    // graph from markdown, and it is what these tests pin down.
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
});
