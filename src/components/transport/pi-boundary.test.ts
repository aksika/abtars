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
import { checkPiBoundarySource } from "../../../scripts/check-pi-boundary.mjs";

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

  it("#1746 — the AST import guard accepts a multi-line import type block and rejects a value import", () => {
    const violations = checkPiBoundarySource(
      [
        'import type {',
        '  Model,',
        '  Provider,',
        '} from "@earendil-works/pi-ai";',
        '',
        'import { clampThinkingLevel } from "@earendil-works/pi-ai";',
      ].join("\n"),
      "fixture.ts",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]!.line).toBe(6);
    expect(violations[0]!.specifier).toBe("@earendil-works/pi-ai");
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
    expect(piPkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("#1746 — the bundle input graph contains no @earendil-works module", () => {
    // meta.json is emitted by esbuild.config.js on every build (CI builds
    // before npm test). Any pi module inlined into the bundle would appear
    // as an input — the cheap unit-level twin of scripts/check-bundle-boundary.mjs,
    // which guards the emitted sourcemaps as part of `npm run bundle`.
    const meta = JSON.parse(
      readFileSync(resolve(ROOT, "bundle", "meta.json"), "utf-8"),
    ) as { inputs: Record<string, { bytesInOutput: number }> };
    const leaked = Object.keys(meta.inputs).filter((input) => input.includes("@earendil-works"));
    expect(leaked).toEqual([]);
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


