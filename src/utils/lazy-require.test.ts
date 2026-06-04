import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock abtarsHome to use temp dir
let tmpDir: string;
vi.mock("../paths.js", () => ({
  abtarsHome: () => tmpDir,
}));

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lazy-require-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("lazyRequire", { timeout: 30000 }, () => {
  it("resolves a globally available package", async () => {
    const { lazyRequire } = await import("./lazy-require.js");
    const path = await lazyRequire("node:path");
    expect(path.join).toBeDefined();
  });

  it("throws with helpful message when package unavailable and install fails", async () => {
    const { lazyRequire } = await import("./lazy-require.js");
    await expect(lazyRequire("__nonexistent_pkg_xyz__", "test")).rejects.toThrow(
      /not available.*abtars deps install/
    );
  });

  it("isInstalled returns false for missing package", async () => {
    const { isInstalled } = await import("./lazy-require.js");
    expect(isInstalled("__nonexistent_pkg_xyz__")).toBe(false);
  });

  it("isInstalled returns true after installPackages", async () => {
    const { isInstalled, installPackages } = await import("./lazy-require.js");
    // Install a tiny package
    installPackages(["is-number"]);
    expect(isInstalled("is-number")).toBe(true);
  });

  it("creates lib dir if missing", async () => {
    const { isInstalled } = await import("./lazy-require.js");
    isInstalled("anything");
    expect(existsSync(join(tmpDir, "lib"))).toBe(true);
  });
});

describe("OPTIONAL_DEPS registry", () => {
  it("has expected entries", async () => {
    const { OPTIONAL_DEPS } = await import("./lazy-require.js");
    expect(OPTIONAL_DEPS.browser).toBeDefined();
    expect(OPTIONAL_DEPS.pdf).toBeDefined();
    expect(OPTIONAL_DEPS.youtube).toBeDefined();
    expect(OPTIONAL_DEPS.image).toBeDefined();
    expect(OPTIONAL_DEPS.browser.packages).toContain("patchright");
  });
});
