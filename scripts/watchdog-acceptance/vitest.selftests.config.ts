import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/watchdog-acceptance/**/*.selftest.ts"],
    testTimeout: 60000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
