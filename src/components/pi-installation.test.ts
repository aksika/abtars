import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  clearPiCache,
  resolveNestedPackageRoot,
  resolveExecutableFromPath,
  resolvePiFromPath,
  resolvePiInstallation,
  resolvePiModuleUrl,
} from "./pi-installation.js";
import type { PiInstallation, PiModuleSpecifier } from "./pi-installation.js";

const loadPiConfigMock = vi.hoisted(() => vi.fn(() => null));

vi.mock("./pi-executor/config.js", () => ({ loadPiConfig: loadPiConfigMock }));

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  clearPiCache();
  loadPiConfigMock.mockReset();
  loadPiConfigMock.mockReturnValue(null);
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-installation-"));
  roots.push(root);
  return root;
}

function piInstallationFixture(version: string): { bin: string; packageRoot: string } {
  const packageRoot = fixture();
  const bin = join(packageRoot, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    version,
  }));
  writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 42\n", "utf-8");
  chmodSync(join(bin, "pi"), 0o755);

  for (const [scope, name] of [
    ["@earendil-works", "pi-ai"],
    ["@earendil-works", "pi-tui"],
    ["@earendil-works", "pi-agent-core"],
  ]) {
    const nestedRoot = join(packageRoot, "node_modules", scope, name);
    mkdirSync(nestedRoot, { recursive: true });
    writeFileSync(join(nestedRoot, "package.json"), JSON.stringify({ name: `${scope}/${name}` }));
  }
  return { bin, packageRoot };
}

describe("resolveNestedPackageRoot", () => {
  it("accepts an ESM-only package nested in the Pi installation", () => {
    const piRoot = fixture();
    const aiRoot = join(piRoot, "node_modules", "@earendil-works", "pi-ai");
    mkdirSync(join(aiRoot, "dist"), { recursive: true });
    writeFileSync(join(aiRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-ai",
      type: "module",
      exports: { ".": { import: "./dist/index.js" } },
    }));
    writeFileSync(join(aiRoot, "dist", "index.js"), "export {};\n");

    expect(resolveNestedPackageRoot(piRoot, "@earendil-works/pi-ai")).toBe(aiRoot);
  });

  it("rejects a nested package symlink that escapes the Pi installation", () => {
    const piRoot = fixture();
    const externalRoot = fixture();
    const scopeRoot = join(piRoot, "node_modules", "@earendil-works");
    mkdirSync(scopeRoot, { recursive: true });
    writeFileSync(join(externalRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai" }));
    symlinkSync(externalRoot, join(scopeRoot, "pi-ai"));

    expect(resolveNestedPackageRoot(piRoot, "@earendil-works/pi-ai")).toBeNull();
  });
});

describe("resolvePiInstallation", () => {
  it("uses package metadata without launching the Pi executable", () => {
    const { bin, packageRoot } = piInstallationFixture("0.82.0");
    const originalPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      const result = resolvePiInstallation({ useCache: false });
      expect(result).toMatchObject({
        state: "compatible",
        installation: {
          packageRoot,
          version: "0.82.0",
        },
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("rejects malformed package versions without executing Pi", () => {
    const { bin } = piInstallationFixture("not-a-version");
    const originalPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      expect(resolvePiInstallation({ useCache: false })).toMatchObject({
        state: "invalid",
        reason: expect.stringContaining("Missing or invalid version"),
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("resolveExecutableFromPath", () => {
  it("resolves a bare name on PATH", () => {
    const dir = fixture();
    const exe = join(dir, "my-pi");
    writeFileSync(exe, "#!/bin/sh\necho hello\n", "utf-8");
    chmodSync(exe, 0o755);
    const origPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      const result = resolveExecutableFromPath("my-pi");
      expect(result).not.toBeNull();
      expect(result!).toBe(exe);
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("returns null for a bare name not on PATH", () => {
    const origPath = process.env.PATH;
    process.env.PATH = "/nonexistent-path-1440";
    try {
      expect(resolveExecutableFromPath("no-such-tool-1440")).toBeNull();
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("returns null for a relative path containing /", () => {
    expect(resolveExecutableFromPath("./pi")).toBeNull();
    expect(resolveExecutableFromPath("subdir/pi")).toBeNull();
  });

  it("returns an existing absolute path", () => {
    const dir = fixture();
    const exe = join(dir, "custom-pi");
    writeFileSync(exe, "#!/bin/sh\necho hello\n", "utf-8");
    chmodSync(exe, 0o755);
    const result = resolveExecutableFromPath(exe);
    expect(result).toBe(exe);
  });

  it("returns null for a nonexistent absolute path", () => {
    expect(resolveExecutableFromPath("/nonexistent-1440/pi")).toBeNull();
  });

  it("resolvePiFromPath is a thin wrapper for 'pi'", () => {
    const dir = fixture();
    const exe = join(dir, "pi");
    writeFileSync(exe, "#!/bin/sh\necho hello\n", "utf-8");
    chmodSync(exe, 0o755);
    const origPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      const result = resolvePiFromPath();
      expect(result).not.toBeNull();
      expect(result!).toBe(exe);
    } finally {
      process.env.PATH = origPath;
    }
  });
});

function makeInstallation(aiRoot: string, tuiRoot: string, agentCoreRoot: string): PiInstallation {
  return {
    executable: "/usr/bin/pi",
    packageRoot: "/usr/lib/pi-coding-agent",
    version: "0.80.7",
    source: "path",
    moduleRoots: { ai: aiRoot, tui: tuiRoot, agentCore: agentCoreRoot },
  };
}

describe("resolvePiModuleUrl", () => {
  it("resolves root specifier to a file URL via import condition", () => {
    const root = fixture();
    const aiRoot = join(root, "pi-ai");
    mkdirSync(join(aiRoot, "dist"), { recursive: true });
    writeFileSync(join(aiRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-ai", type: "module",
      exports: { ".": { import: "./dist/index.js" } },
    }));
    writeFileSync(join(aiRoot, "dist", "index.js"), "export const x = 1;\n");
    const installation = makeInstallation(aiRoot, fixture(), fixture());
    const url = resolvePiModuleUrl(installation, { package: "@earendil-works/pi-ai" });
    expect(url.protocol).toBe("file:");
    expect(fileURLToPath(url)).toBe(join(aiRoot, "dist", "index.js"));
  });

  it("resolves root specifier via default condition when import is absent", () => {
    const root = fixture();
    const aiRoot = join(root, "pi-ai");
    mkdirSync(join(aiRoot, "dist"), { recursive: true });
    writeFileSync(join(aiRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-ai", type: "module",
      exports: { ".": { default: "./dist/index.js" } },
    }));
    writeFileSync(join(aiRoot, "dist", "index.js"), "export const x = 1;\n");
    const installation = makeInstallation(aiRoot, fixture(), fixture());
    const url = resolvePiModuleUrl(installation, { package: "@earendil-works/pi-ai" });
    expect(fileURLToPath(url)).toBe(join(aiRoot, "dist", "index.js"));
  });

  it("resolves root specifier when exports value is a direct string", () => {
    const root = fixture();
    const aiRoot = join(root, "pi-ai");
    mkdirSync(join(aiRoot, "dist"), { recursive: true });
    writeFileSync(join(aiRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-ai",
      exports: "./dist/index.js",
    }));
    writeFileSync(join(aiRoot, "dist", "index.js"), "export const x = 1;\n");
    const installation = makeInstallation(aiRoot, fixture(), fixture());
    const url = resolvePiModuleUrl(installation, { package: "@earendil-works/pi-ai" });
    expect(fileURLToPath(url)).toBe(join(aiRoot, "dist", "index.js"));
  });

  it("resolves a subpath via wildcard export (api/openai-completions)", () => {
    const root = fixture();
    const aiRoot = join(root, "pi-ai");
    mkdirSync(join(aiRoot, "dist", "api"), { recursive: true });
    writeFileSync(join(aiRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-ai", type: "module",
      exports: {
        ".": { import: "./dist/index.js" },
        "./api/*": { import: "./dist/api/*.js" },
      },
    }));
    writeFileSync(join(aiRoot, "dist", "api", "openai-completions.js"), "export const stream = async function*(){};\n");
    const installation = makeInstallation(aiRoot, fixture(), fixture());
    const url = resolvePiModuleUrl(installation, { package: "@earendil-works/pi-ai", subpath: "api/openai-completions" });
    expect(fileURLToPath(url)).toBe(join(aiRoot, "dist", "api", "openai-completions.js"));
  });

  it("resolves a providers wildcard subpath", () => {
    const root = fixture();
    const aiRoot = join(root, "pi-ai");
    mkdirSync(join(aiRoot, "dist", "providers"), { recursive: true });
    writeFileSync(join(aiRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-ai", type: "module",
      exports: {
        ".": { import: "./dist/index.js" },
        "./providers/*": { import: "./dist/providers/*.js" },
      },
    }));
    writeFileSync(join(aiRoot, "dist", "providers", "all.js"), "export const builtinModels = () => ({});\n");
    const installation = makeInstallation(aiRoot, fixture(), fixture());
    const url = resolvePiModuleUrl(installation, { package: "@earendil-works/pi-ai", subpath: "providers/all" });
    expect(fileURLToPath(url)).toBe(join(aiRoot, "dist", "providers", "all.js"));
  });

  it("pi-tui specifier resolves from the tui module root", () => {
    const root = fixture();
    const tuiRoot = join(root, "pi-tui");
    mkdirSync(join(tuiRoot, "dist"), { recursive: true });
    writeFileSync(join(tuiRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-tui",
      exports: { ".": { import: "./dist/index.js" } },
    }));
    writeFileSync(join(tuiRoot, "dist", "index.js"), "export class TUI {}\n");
    const installation = makeInstallation(fixture(), tuiRoot, fixture());
    const url = resolvePiModuleUrl(installation, { package: "@earendil-works/pi-tui" });
    expect(fileURLToPath(url)).toBe(join(tuiRoot, "dist", "index.js"));
  });

  it("rejects when package.json name does not match specifier", () => {
    const root = fixture();
    const aiRoot = join(root, "pi-ai");
    mkdirSync(aiRoot, { recursive: true });
    writeFileSync(join(aiRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-ai-old",
      exports: { ".": { import: "./dist/index.js" } },
    }));
    const installation = makeInstallation(aiRoot, fixture(), fixture());
    expect(() => resolvePiModuleUrl(installation, { package: "@earendil-works/pi-ai" }))
      .toThrow(/name mismatch/);
  });

  it("rejects when exports field is missing", () => {
    const root = fixture();
    const aiRoot = join(root, "pi-ai");
    mkdirSync(aiRoot, { recursive: true });
    writeFileSync(join(aiRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai" }));
    const installation = makeInstallation(aiRoot, fixture(), fixture());
    expect(() => resolvePiModuleUrl(installation, { package: "@earendil-works/pi-ai" }))
      .toThrow(/no "exports" field/);
  });

  it("rejects a missing subpath export", () => {
    const root = fixture();
    const aiRoot = join(root, "pi-ai");
    mkdirSync(aiRoot, { recursive: true });
    writeFileSync(join(aiRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-ai",
      exports: { ".": { import: "./dist/index.js" } },
    }));
    const installation = makeInstallation(aiRoot, fixture(), fixture());
    expect(() => resolvePiModuleUrl(installation, { package: "@earendil-works/pi-ai", subpath: "api/nonexistent" }))
      .toThrow(/no executable export target/);
  });

  it("rejects a non-relative export target", () => {
    const root = fixture();
    const aiRoot = join(root, "pi-ai");
    mkdirSync(aiRoot, { recursive: true });
    writeFileSync(join(aiRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-ai",
      exports: { ".": { import: "/absolute/path.js" } },
    }));
    const installation = makeInstallation(aiRoot, fixture(), fixture());
    expect(() => resolvePiModuleUrl(installation, { package: "@earendil-works/pi-ai" }))
      .toThrow(/must be a relative/);
  });

  it("rejects an export target that escapes the package root via ../", () => {
    const root = fixture();
    const aiRoot = join(root, "pi-ai");
    mkdirSync(aiRoot, { recursive: true });
    writeFileSync(join(aiRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-ai",
      exports: { ".": { import: "../escaped.js" } },
    }));
    const installation = makeInstallation(aiRoot, fixture(), fixture());
    expect(() => resolvePiModuleUrl(installation, { package: "@earendil-works/pi-ai" }))
      .toThrow(/must be a relative/);
  });

  it("rejects a symlink that escapes the package root", () => {
    const root = fixture();
    const externalRoot = fixture();
    const escapedTarget = join(externalRoot, "malicious.js");
    writeFileSync(escapedTarget, "export const x = 1;\n");
    const aiRoot = join(root, "pi-ai");
    mkdirSync(join(aiRoot, "dist"), { recursive: true });
    symlinkSync(escapedTarget, join(aiRoot, "dist", "evil.js"));
    writeFileSync(join(aiRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-ai",
      exports: { ".": { import: "./dist/evil.js" } },
    }));
    const installation = makeInstallation(aiRoot, fixture(), fixture());
    expect(() => resolvePiModuleUrl(installation, { package: "@earendil-works/pi-ai" }))
      .toThrow(/escapes package root/);
  });

  it("rejects a missing target file", () => {
    const root = fixture();
    const aiRoot = join(root, "pi-ai");
    mkdirSync(aiRoot, { recursive: true });
    writeFileSync(join(aiRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-ai",
      exports: { ".": { import: "./dist/missing.js" } },
    }));
    const installation = makeInstallation(aiRoot, fixture(), fixture());
    expect(() => resolvePiModuleUrl(installation, { package: "@earendil-works/pi-ai" }))
      .toThrow(/does not resolve to an existing file/);
  });

  it("rejects malformed package.json", () => {
    const root = fixture();
    const aiRoot = join(root, "pi-ai");
    mkdirSync(aiRoot, { recursive: true });
    writeFileSync(join(aiRoot, "package.json"), "not json");
    const installation = makeInstallation(aiRoot, fixture(), fixture());
    expect(() => resolvePiModuleUrl(installation, { package: "@earendil-works/pi-ai" }))
      .toThrow(/malformed package\.json/);
  });

  it("returns a file URL (not a file path)", () => {
    const root = fixture();
    const aiRoot = join(root, "pi-ai");
    mkdirSync(join(aiRoot, "dist"), { recursive: true });
    writeFileSync(join(aiRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-ai",
      exports: { ".": { import: "./dist/index.js" } },
    }));
    writeFileSync(join(aiRoot, "dist", "index.js"), "export const x = 1;\n");
    const installation = makeInstallation(aiRoot, fixture(), fixture());
    const url = resolvePiModuleUrl(installation, { package: "@earendil-works/pi-ai" });
    expect(url.protocol).toBe("file:");
    expect(url.pathname).toContain("/dist/index.js");
  });
});
