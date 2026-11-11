import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The integration tests build real git repos with real worktrees and shell
    // out to git for every step, which is comfortably slower than the default.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    include: ["test/**/*.test.ts"],
  },
});
