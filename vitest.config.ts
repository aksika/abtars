import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^abmind\/deploy-lib\/(.+)/, replacement: resolve(__dirname, "../abmind/dist/src/deploy-lib/$1") },
      { find: /^abmind$/, replacement: resolve(__dirname, "../abmind/dist/src/index.js") },
    ],
  },
  test: {
    setupFiles: ["./src/test-support/runtime-isolation.ts"],
  },
});
