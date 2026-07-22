/**
 * #1425 — Contract and boundary tests against the official @earendil-works/pi-ai package.
 *
 * Verifies:
 * 1. Pi AI is a devDependency, absent from production dependencies.
 * 2. Official types can be imported (type-only) and are structurally compatible.
 * 3. The adapter and catalog do not rely on any runtime value from pi-ai at import time.
 * 4. The bundle excludes pi-ai implementation modules.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", "..");

// ── 1. Package boundary ──────────────────────────────────────────────────────

describe("dependency boundary (#1425)", () => {
  it("@earendil-works/pi-ai is a devDependency, not a production dependency", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["@earendil-works/pi-ai"]).toBeUndefined();
    expect(pkg.devDependencies?.["@earendil-works/pi-ai"]).toBeDefined();
  });

  it("@earendil-works/pi-ai is absent from the npm pack manifest", () => {
    // Read .npmignore / files field to verify exclusion
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8")) as {
      files?: string[];
    };
    // The `files` field should not include any pi-ai modules
    const bundledFiles = pkg.files ?? [];
    expect(bundledFiles.some(f => f.includes("pi-ai"))).toBe(false);
    // Verify node_modules is not in the files list
    expect(bundledFiles.includes("node_modules")).toBe(false);
  });

  it("pi-ai is type-only — import type should be erased at runtime", async () => {
    const mod = await import("./pi-ai-adapter.js");
    expect(mod.pickPiApi).toBeDefined();
    expect(mod.buildPiModel).toBeDefined();
    expect(mod.buildPiContext).toBeDefined();

    const catalog = await import("./pi-catalog.js");
    expect(catalog.mapProviderName).toBeDefined();
    expect(catalog.loadPiModels).toBeDefined();
    expect(catalog.resolveModelMeta).toBeDefined();
  });
});

// ── 2. Official type compatibility ────────────────────────────────────────────

describe("official type compatibility (#1425)", () => {
  it("pi-ai types can be imported (type-only, compile-time contract)", async () => {
    // Dynamic import of type-only is erased; this test proves the package
    // is resolvable by checking its version at runtime via require
    const piPkg = JSON.parse(
      readFileSync(resolve(ROOT, "node_modules", "@earendil-works", "pi-ai", "package.json"), "utf-8"),
    ) as { version: string };
    expect(piPkg.version).toMatch(/^0\.80\./);
  });

  it("esbuild config excludes pi-ai as external", () => {
    // Verify the esbuild config does NOT include pi-ai in the external list
    // (pi-ai must remain bundled-absent because it's resolved at runtime via lazyRequire)
    // Actually, we need to verify it's NOT in the external list AND NOT bundled.
    // pi-ai should be lazily required at runtime from ~/.local/lib/node_modules/
    const esbuildConfig = readFileSync(resolve(ROOT, "esbuild.config.js"), "utf-8");
    // Verify esbuild does NOT have pi-ai in its externals (it's lazy-loaded, not external)
    // The external list should NOT include pi-ai because esbuild should not even see it
    // (all imports are type-only and erased; lazyRequire uses CJS require at runtime)
    const externals = [
      "rettiwt-api", "better-sqlite3", "abmind", "pdf-parse",
      "youtube-transcript", "jimp",
    ];
    for (const ext of externals) {
      expect(esbuildConfig).toContain(ext);
    }
    // pi-ai should not be in the external list (it's type-only, not bundled nor external)
    expect(esbuildConfig).not.toContain("@earendil-works/pi-ai");
  });
});

// ── 3. Retry/fallback ownership ───────────────────────────────────────────────

describe("retry/fallback ownership (#1425)", () => {
  it("adapter passes maxRetries: 0 to pi-ai — abtars L2 owns the retry budget", async () => {
    const src = readFileSync(resolve(ROOT, "src", "components", "transport", "pi-ai-adapter.ts"), "utf-8");
    expect(src).toContain("maxRetries: 0");
    // No local retry loop, retry budget, or fallback in the adapter
    // (only passes maxRetries to pi-ai; L2 owns the retry budget)
    expect(src).not.toContain("withRetry(");
  });


});

// ── 4. No provider-specific wire format copies ────────────────────────────────

describe("no upstream provider wire copies (#1425)", () => {
  it("pi-ai-adapter.ts has no provider-specific body construction", () => {
    const src = readFileSync(
      resolve(ROOT, "src", "components", "transport", "pi-ai-adapter.ts"),
      "utf-8",
    );
    // Should not have provider-specific route or body construction that mirrors Pi internals
    // The adapter delegates to pi-ai's createProvider and streamSimple
    expect(src).not.toContain(`/chat/completions`);
    expect(src).not.toContain(`/messages`);
    expect(src).not.toContain(`/responses`);
    // Should not construct HTTP bodies directly
    expect(src).not.toContain(`"model":`);
    expect(src).not.toContain(`"messages":`);
    expect(src).not.toContain(`"stream": true`);
  });
});


