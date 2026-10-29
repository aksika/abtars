import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Native deps (better-sqlite3, sqlite-vec) are installed centrally by
// `abmind deps install` to ~/.local/lib/node_modules and shared by abmind,
// abtars, and anything else using them. Production resolves them via NODE_PATH
// plus createRequire, but vitest/vite ignores NODE_PATH, so bridge the shared
// path with a resolve.alias exactly as abmind's vitest.config.ts does.
// Integration tests (src/tests/integration/harness.ts) need it. Guarded, so a
// host with a local install or CI falls through to normal resolution.
const sharedSqlite = join(homedir(), ".local", "lib", "node_modules", "better-sqlite3");

export default defineConfig({
  resolve: {
    alias: [
      { find: /^abmind$/, replacement: resolve(__dirname, "../abmind/dist/src/index.js") },
      ...(existsSync(sharedSqlite) ? [{ find: /^better-sqlite3$/, replacement: sharedSqlite }] : []),
    ],
  },
  test: {
    setupFiles: ["./src/test-support/runtime-isolation.ts"],
  },
});
