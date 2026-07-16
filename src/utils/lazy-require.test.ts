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
    expect(OPTIONAL_DEPS.pdf).toBeDefined();
    expect(OPTIONAL_DEPS.youtube).toBeDefined();
    expect(OPTIONAL_DEPS.image).toBeDefined();
  });

  it("does not include Pi groups (now a single external distribution)", async () => {
    const { OPTIONAL_DEPS } = await import("./lazy-require.js");
    expect(OPTIONAL_DEPS.provider).toBeUndefined();
    expect(OPTIONAL_DEPS.tui).toBeUndefined();
  });
});

// #1311: ESM can't import a directory path — lazy-require resolves the package's main
// entry from package.json before importing. The tests below pin each branch of
// resolvePackageEntry without depending on a real package install.
describe("resolvePackageEntry (package.json → entry file)", () => {
  it('honors exports["."]["import"] (ESM, conditional)', async () => {
    const { lazyRequire } = await import("./lazy-require.js");
    // Stage a fixture ESM package under the mocked lib path.
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

  it("resolves a subpath import via exports wildcard (./api/* → ./dist/api/*.js)", async () => {
    const { lazyRequire } = await import("./lazy-require.js");
    // Stage a fixture that mirrors pi-ai's exports: { "./api/*": { "import": "./dist/api/*.js" } }
    const staged = join(tmpDir, ".local", "lib", "node_modules", "fixture-sub");
    mkdirSync(join(staged, "dist", "api"), { recursive: true });
    writeFileSync(join(staged, "package.json"), JSON.stringify({
      type: "module",
      exports: {
        ".": { "import": "./dist/index.js" },
        "./api/*": { "import": "./dist/api/*.js" },
      },
    }));
    writeFileSync(join(staged, "dist", "index.js"), "export const root = 'ok';");
    writeFileSync(join(staged, "dist", "api", "openai-completions.js"), "export const family = 'openai-completions';");
    const mod = await lazyRequire("fixture-sub/api/openai-completions") as { family?: string };
    expect(mod.family).toBe("openai-completions");
  });

  it("resolves a scoped subpath import (@scope/name/sub)", async () => {
    const { lazyRequire } = await import("./lazy-require.js");
    // Stage a scoped fixture like @earendil-works/pi-ai/api/openai-completions
    const staged = join(tmpDir, ".local", "lib", "node_modules", "@earendil-works", "fixture-scope");
    mkdirSync(join(staged, "dist"), { recursive: true });
    writeFileSync(join(staged, "package.json"), JSON.stringify({
      name: "@earendil-works/fixture-scope",
      type: "module",
      exports: { ".": { "import": "./dist/index.js" } },
    }));
    writeFileSync(join(staged, "dist", "index.js"), "export const tag = 'scoped-root';");
    const mod = await lazyRequire("@earendil-works/fixture-scope") as { tag?: string };
    expect(mod.tag).toBe("scoped-root");
  });
});
