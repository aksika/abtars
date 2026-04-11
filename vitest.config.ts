import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "abmind": resolve(__dirname, "packages/memory/src"),
    },
  },
});
