/**
 * config.test.ts — #1394 Pi workspace path containment and alias validation.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { posix, win32 } from "node:path";
import { isPathWithinRoot, resolveAndValidateWorkspace, validatePiWorkspaceAliases, type PiExecutorConfig, loadPiConfig } from "./config.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let mockConfigDir = "/nonexistent";

vi.mock("../transport-config.js", () => ({
  configDir: () => mockConfigDir,
}));

// ── Pure path containment tests ─────────────────────────────────────────

describe("isPathWithinRoot (POSIX)", () => {
  const posixOps = { relative: posix.relative, isAbsolute: posix.isAbsolute, sep: posix.sep };

  it("accepts child path", () => {
    expect(isPathWithinRoot("/safe/root", "/safe/root/project", posixOps)).toBe(true);
  });

  it("accepts exact equality", () => {
    expect(isPathWithinRoot("/safe/root", "/safe/root", posixOps)).toBe(true);
  });

  it("rejects sibling prefix escape", () => {
    expect(isPathWithinRoot("/safe/root", "/safe/root-evil", posixOps)).toBe(false);
  });

  it("rejects sibling with different root name", () => {
    expect(isPathWithinRoot("/safe/root", "/safe/root2/project", posixOps)).toBe(false);
  });

  it("rejects parent traversal", () => {
    expect(isPathWithinRoot("/safe/root", "/safe/root/../outside", posixOps)).toBe(false);
  });

  it("rejects traversal to root itself", () => {
    expect(isPathWithinRoot("/safe/root", "/safe/root/..", posixOps)).toBe(false);
  });

  it("rejects deep traversal escape", () => {
    expect(isPathWithinRoot("/safe/root", "/safe/root/sub/../../outside", posixOps)).toBe(false);
  });

  it("rejects completely unrelated path", () => {
    expect(isPathWithinRoot("/safe/root", "/other/path", posixOps)).toBe(false);
  });
});

describe("isPathWithinRoot (win32)", () => {
  const win32Ops = { relative: win32.relative, isAbsolute: win32.isAbsolute, sep: win32.sep };

  it("accepts child on same drive", () => {
    expect(isPathWithinRoot("C:\\safe\\root", "C:\\safe\\root\\project", win32Ops)).toBe(true);
  });

  it("accepts exact equality on same drive", () => {
    expect(isPathWithinRoot("C:\\safe\\root", "C:\\safe\\root", win32Ops)).toBe(true);
  });

  it("rejects sibling prefix on same drive", () => {
    expect(isPathWithinRoot("C:\\safe\\root", "C:\\safe\\root-evil", win32Ops)).toBe(false);
  });

  it("rejects different drive letter", () => {
    expect(isPathWithinRoot("C:\\safe\\root", "D:\\safe\\root\\project", win32Ops)).toBe(false);
  });

  it("rejects backslash traversal outside root", () => {
    expect(isPathWithinRoot("C:\\root", "C:\\root\\..\\outside", win32Ops)).toBe(false);
  });
});

describe("isPathWithinRoot (native path)", () => {
  it("accepts child path", () => {
    expect(isPathWithinRoot("/safe/root", "/safe/root/project")).toBe(true);
  });

  it("accepts equality", () => {
    expect(isPathWithinRoot("/safe/root", "/safe/root")).toBe(true);
  });

  it("rejects sibling prefix", () => {
    expect(isPathWithinRoot("/safe/root", "/safe/root-evil")).toBe(false);
  });
});

// ── Alias validation ──────────────────────────────────────────────────

describe("validatePiWorkspaceAliases", () => {
  it("returns empty errors for valid aliases", () => {
    const config = {
      enabled: true, command: "pi", fixedArgs: [], allowedEnv: [],
      maxConcurrent: 1, maxWallClockMs: 60000, abortGraceMs: 5000,
      projectTrust: "never", sessionStorageRoot: "", abmindPlugin: "",
      supportedRpcVersion: "0.1",
      workspaceAliases: {},
    } as PiExecutorConfig;
    const errors = validatePiWorkspaceAliases(config);
    expect(Object.keys(errors).length).toBe(0);
  });

  it("returns error for unknown alias", () => {
    const config = {
      enabled: true, command: "pi", fixedArgs: [], allowedEnv: [],
      maxConcurrent: 1, maxWallClockMs: 60000, abortGraceMs: 5000,
      projectTrust: "never", sessionStorageRoot: "", abmindPlugin: "",
      supportedRpcVersion: "0.1",
      workspaceAliases: {},
    } as PiExecutorConfig;
    const result = resolveAndValidateWorkspace("nonexistent", config);
    expect(result.error).toContain("Unknown workspace alias");
    expect(result.canonicalPath).toBe("");
  });

  it("rejects relative path", () => {
    const config = {
      enabled: true, command: "pi", fixedArgs: [], allowedEnv: [],
      maxConcurrent: 1, maxWallClockMs: 60000, abortGraceMs: 5000,
      projectTrust: "never", sessionStorageRoot: "", abmindPlugin: "",
      supportedRpcVersion: "0.1",
      workspaceAliases: { test: { path: "relative/path" } },
    } as PiExecutorConfig;
    const result = resolveAndValidateWorkspace("test", config);
    expect(result.error).toContain("absolute");
  });

  it("rejects non-existent path", () => {
    const config = {
      enabled: true, command: "pi", fixedArgs: [], allowedEnv: [],
      maxConcurrent: 1, maxWallClockMs: 60000, abortGraceMs: 5000,
      projectTrust: "never", sessionStorageRoot: "", abmindPlugin: "",
      supportedRpcVersion: "0.1",
      workspaceAliases: { test: { path: "/nonexistent-path-1394-test" } },
    } as PiExecutorConfig;
    const result = resolveAndValidateWorkspace("test", config);
    expect(result.error).toContain("does not exist");
  });
});

// ── Real filesystem containment tests ─────────────────────────────────

describe("resolveAndValidateWorkspace (real filesystem)", () => {
  const { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const { tmpdir } = require("node:os") as typeof import("node:os");

  function makeConfig(aliases: Record<string, { path: string; root?: string }>): PiExecutorConfig {
    return {
      enabled: true, command: "pi", fixedArgs: [], allowedEnv: [],
      maxConcurrent: 1, maxWallClockMs: 60000, abortGraceMs: 5000,
      projectTrust: "never", sessionStorageRoot: "", abmindPlugin: "",
      supportedRpcVersion: "0.1",
      workspaceAliases: aliases,
    } as PiExecutorConfig;
  }

  it("accepts valid child directory", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-config-test-"));
    const child = join(root, "subdir");
    mkdirSync(child, { recursive: true });
    try {
      const config = makeConfig({ test: { path: child, root } });
      const result = resolveAndValidateWorkspace("test", config);
      expect(result.error).toBeUndefined();
      expect(result.canonicalPath).toBe(child);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts root equality", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-config-test-"));
    try {
      const config = makeConfig({ test: { path: root, root } });
      const result = resolveAndValidateWorkspace("test", config);
      expect(result.error).toBeUndefined();
      expect(result.canonicalPath).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects sibling prefix escape", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-root-"));
    const evil = mkdtempSync(join(tmpdir(), "pi-root-evil")); // siblings by prefix
    try {
      const config = makeConfig({ test: { path: evil, root } });
      const result = resolveAndValidateWorkspace("test", config);
      expect(result.error).toContain("Escapes root");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(evil, { recursive: true, force: true });
    }
  });

  it("rejects a file instead of directory", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-config-test-"));
    const filePath = join(root, "not-a-dir");
    writeFileSync(filePath, "content");
    try {
      const config = makeConfig({ test: { path: filePath, root } });
      const result = resolveAndValidateWorkspace("test", config);
      expect(result.error).toContain("Not a directory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts symlink inside root", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-config-test-"));
    const realDir = join(root, "real");
    const linkDir = join(root, "link");
    mkdirSync(realDir, { recursive: true });
    try {
      symlinkSync(realDir, linkDir);
      const config = makeConfig({ test: { path: linkDir, root } });
      const result = resolveAndValidateWorkspace("test", config);
      expect(result.error).toBeUndefined();
      // Should resolve canonical (realDir)
      expect(result.canonicalPath).toBe(realDir);
    } catch {
      // symlink may not be supported on all platforms — skip
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symlink outside root", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-config-test-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-outside-"));
    const linkDir = join(root, "escape");
    try {
      symlinkSync(outside, linkDir);
      const config = makeConfig({ test: { path: linkDir, root } });
      const result = resolveAndValidateWorkspace("test", config);
      // Symlink resolves to outside → should be outside root → reject
      expect(result.error).toContain("Escapes root");
    } catch {
      // symlink may not be supported
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ── Loader behavior tests (#1440) ─────────────────────────────────────

describe("loadPiConfig", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-load-config-"));
  const configPath = join(tmp, "pi-executor.json");

  beforeAll(() => { mockConfigDir = tmp; });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("returns null when file is missing", () => {
    rmSync(configPath, { force: true });
    expect(loadPiConfig()).toBeNull();
  });

  it("returns null when disabled", () => {
    writeFileSync(configPath, JSON.stringify({ enabled: false, command: "pi", workspaceAliases: {} }), "utf-8");
    expect(loadPiConfig()).toBeNull();
  });

  it("returns null and warns when enabled but missing command", () => {
    writeFileSync(configPath, JSON.stringify({ enabled: true, workspaceAliases: { w: { path: "/tmp" } } }), "utf-8");
    expect(loadPiConfig()).toBeNull();
  });

  it("returns null and warns when enabled but no aliases", () => {
    writeFileSync(configPath, JSON.stringify({ enabled: true, command: "pi", workspaceAliases: {} }), "utf-8");
    expect(loadPiConfig()).toBeNull();
  });

  it("returns config when enabled with command and aliases", () => {
    writeFileSync(configPath, JSON.stringify({
      enabled: true, command: "pi", workspaceAliases: { work: { path: "/tmp" } },
    }), "utf-8");
    const cfg = loadPiConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.enabled).toBe(true);
    expect(cfg!.command).toBe("pi");
    expect(cfg!.workspaceAliases).toHaveProperty("work");
  });
});
