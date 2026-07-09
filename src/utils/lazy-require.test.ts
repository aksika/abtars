import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock homedir so lib dir resolves under a temp dir (code uses ~/.local/lib via homedir())
let tmpDir: string;
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => tmpDir };
});

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
    expect(existsSync(join(tmpDir, ".local", "lib"))).toBe(true);
  });
});

describe("OPTIONAL_DEPS registry", () => {
  it("has expected entries", async () => {
    const { OPTIONAL_DEPS } = await import("./lazy-require.js");
    expect(OPTIONAL_DEPS.browser).toBeDefined();
    expect(OPTIONAL_DEPS.pdf).toBeDefined();
    expect(OPTIONAL_DEPS.youtube).toBeDefined();
    expect(OPTIONAL_DEPS.image).toBeDefined();
    expect(OPTIONAL_DEPS.browser.packages).toContain("cloakbrowser");
  });
});

// #1311: ESM can't import a directory path — lazy-require resolves the package's main
// entry from package.json before importing. The tests below pin each branch of
// resolvePackageEntry without depending on a real package install.
describe("resolvePackageEntry (package.json → entry file)", () => {
  it('honors exports["."]["import"] (ESM, conditional)', async () => {
    const pkgDir = join(tmpDir, "pkg-exports-import");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
      type: "module",
      exports: { ".": { "import": "./dist/index.js" } },
    }));
    // We exercise the public lazyRequire path by mocking fs in a way that
    // resolvePackageEntry is reachable; here we just verify the function via
    // the same module's internal helper by reaching into a test fixture.
    // The function isn't exported — so we re-import the module and assert
    // by side-effect: lazyRequire against a fixture that has only exports.
    const { lazyRequire } = await import("./lazy-require.js");
    // Create a tiny ESM file the lazy-require can load.
    writeFileSync(join(pkgDir, "dist", "index.js"), "export const marker = 'ok-from-exports-import';");
    // Stage the package under the mocked lib path.
    const staged = join(tmpDir, ".local", "lib", "node_modules", "fixture-exi");
    mkdirSync(join(staged, "dist"), { recursive: true });
    writeFileSync(join(staged, "package.json"), JSON.stringify({
      type: "module",
      exports: { ".": { "import": "./dist/index.js" } },
    }));
    writeFileSync(join(staged, "dist", "index.js"), "export const marker = 'ok-from-exports-import';");
    const mod = await lazyRequire("fixture-exi") as { marker?: string };
    expect(mod.marker).toBe("ok-from-exports-import");
  });
});
