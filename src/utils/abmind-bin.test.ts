/**
 * abmind-bin.test.ts — #1308 follow-up.
 *
 * Tests the absolute-path resolver used to spawn the abmind CLI from the bridge
 * (where PATH doesn't include the nvm bin dir). Each test resets ABMIND_PATH
 * and points it at a fixture package dir; the resolver walks the discovery
 * strategies and reads `package.json#bin.abmind` to compute the bin path.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveAbmindBin } from "./abmind-bin.js";

/** Build a fake abmind package with a `bin.abmind` entry pointing at a real file. */
function buildFakeBinPkg(dir: string, opts: { version: string; binRel: string }): void {
  mkdirSync(join(dir, "dist", "cli"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "abmind", version: opts.version, bin: { abmind: opts.binRel },
  }));
  // The bin target must exist for existsSync to pass.
  writeFileSync(join(dir, opts.binRel), "#!/usr/bin/env node\n");
}

/** Build a fake abmind package whose `bin.abmind` entry references a MISSING file. */
function buildFakeBinPkgMissingFile(dir: string, opts: { version: string; binRel: string }): void {
  mkdirSync(join(dir, "dist", "cli"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "abmind", version: opts.version, bin: { abmind: opts.binRel },
  }));
  // Intentionally do NOT create the bin target.
}

describe("resolveAbmindBin — ABMIND_PATH strategy (#1308 follow-up)", () => {
  let tmp: string;
  const origEnv = process.env["ABMIND_PATH"];

  beforeEach(() => {
    tmp = join(tmpdir(), `abmind-bin-${Date.now()}-${process.pid}`);
    mkdirSync(tmp, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env["ABMIND_PATH"];
    else process.env["ABMIND_PATH"] = origEnv;
  });

  it("returns absolute path to bin when ABMIND_PATH points at a valid pkg", () => {
    buildFakeBinPkg(tmp, { version: "0.2.7-alpha.0", binRel: "dist/cli/abmind.js" });
    process.env["ABMIND_PATH"] = tmp;
    const bin = resolveAbmindBin();
    expect(bin).toBe(join(tmp, "dist", "cli", "abmind.js"));
  });

  it("falls through to next strategy when ABMIND_PATH points at a dir without package.json", () => {
    // Same fall-through semantics as loadAbmind: a missing file is "this
    // strategy didn't claim a winner", not "this strategy rejected". The
    // resolver tries the next strategy. On a real host that has a valid
    // abmind elsewhere (createRequire/npm-root-g), the resolver returns
    // that path. We only assert the call doesn't throw.
    process.env["ABMIND_PATH"] = tmp; // empty fixture dir, no package.json
    expect(() => resolveAbmindBin()).not.toThrow();
  });

  it("returns null when the bin entry's target file does not exist on disk", () => {
    buildFakeBinPkgMissingFile(tmp, { version: "0.2.7-alpha.0", binRel: "dist/cli/missing.js" });
    process.env["ABMIND_PATH"] = tmp;
    expect(resolveAbmindBin()).toBeNull();
  });

  it("returns null when the package version is below the supported floor (0.2.6)", () => {
    buildFakeBinPkg(tmp, { version: "0.2.5", binRel: "dist/cli/abmind.js" });
    process.env["ABMIND_PATH"] = tmp;
    expect(resolveAbmindBin()).toBeNull();
  });

  it("returns null when package.json has no bin field", () => {
    mkdirSync(join(tmp, "dist", "cli"), { recursive: true });
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "abmind", version: "0.2.7" }));
    writeFileSync(join(tmp, "dist", "cli", "abmind.js"), "#!/usr/bin/env node\n");
    process.env["ABMIND_PATH"] = tmp;
    expect(resolveAbmindBin()).toBeNull();
  });

  it("accepts string-form bin (not just {abmind: ...})", () => {
    mkdirSync(join(tmp, "dist", "cli"), { recursive: true });
    writeFileSync(join(tmp, "package.json"), JSON.stringify({
      name: "abmind", version: "0.2.7", bin: "dist/cli/abmind.js",
    }));
    writeFileSync(join(tmp, "dist", "cli", "abmind.js"), "#!/usr/bin/env node\n");
    process.env["ABMIND_PATH"] = tmp;
    expect(resolveAbmindBin()).toBe(join(tmp, "dist", "cli", "abmind.js"));
  });

  it("respects below-floor as a hard stop — does not silently fall through", () => {
    // Below-floor ABMIND_PATH should not be overridden by a higher-priority
    // candidate. The resolver returns null and the caller falls back to bare
    // "abmind" (which then produces a clear error in the new close handler).
    buildFakeBinPkg(tmp, { version: "0.1.0", binRel: "dist/cli/abmind.js" });
    process.env["ABMIND_PATH"] = tmp;
    expect(resolveAbmindBin()).toBeNull();
  });
});
