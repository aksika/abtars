import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveNestedPackageRoot, resolveExecutableFromPath, resolvePiFromPath } from "./pi-installation.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-installation-"));
  roots.push(root);
  return root;
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
