import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEmptyManifest, upsertRecord, writeManifest } from "../deploy-lib/shared-native-deps-manifest.js";

let tmpDir: string;
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => tmpDir };
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "deps-test-"));
  mkdirSync(join(tmpDir, ".local", "lib", "node_modules"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Mock spawnSync so we never actually run npm install in tests
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn((cmd: string, args: string[], opts?: Record<string, unknown>) => {
      // For "which <binary>" in list(), let it pass through
      if (cmd === "which") return actual.spawnSync(cmd, args, opts);
      // For npm install/update, return success
      return { status: 0, error: undefined, stdout: "", stderr: "" };
    }),
  };
});

// ── observePackage ────────────────────────────────────────────────────────────

describe("observePackage", () => {
  it("returns absent when package.json missing", async () => {
    const { observePackage } = await import("./deps.js");
    expect(observePackage("nonexistent")).toEqual({ state: "absent" });
  });

  it("returns installed with version when package.json is valid", async () => {
    const pkgDir = join(tmpDir, ".local", "lib", "node_modules", "test-pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "1.2.3" }));

    const { observePackage } = await import("./deps.js");
    expect(observePackage("test-pkg")).toEqual({ state: "installed", version: "1.2.3" });
  });

  it("returns invalid for malformed json", async () => {
    const pkgDir = join(tmpDir, ".local", "lib", "node_modules", "bad-pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), "not json");

    const { observePackage } = await import("./deps.js");
    expect(observePackage("bad-pkg")).toEqual({ state: "invalid", reason: "invalid-json" });
  });

  it("returns invalid when version field is missing", async () => {
    const pkgDir = join(tmpDir, ".local", "lib", "node_modules", "no-ver");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "no-ver" }));

    const { observePackage } = await import("./deps.js");
    expect(observePackage("no-ver")).toEqual({ state: "invalid", reason: "missing-version" });
  });
});

// ── observeGroup ──────────────────────────────────────────────────────────────

describe("observeGroup", () => {
  it("returns absent when no packages installed", async () => {
    const { observeGroup } = await import("./deps.js");
    const obs = observeGroup("pdf");
    expect(obs.state).toBe("absent");
    expect(obs.packages.length).toBeGreaterThan(0);
    expect(obs.packages.every(p => p.observed.state === "absent")).toBe(true);
  });

  it("returns drifted when some packages installed at wrong version", async () => {
    // native has two packages: better-sqlite3 and sqlite-vec.
    // Installing one at an arbitrary version makes the group "drifted"
    // because the target ("latest") doesn't match "1.0.0".
    const pkgDir1 = join(tmpDir, ".local", "lib", "node_modules", "better-sqlite3");
    mkdirSync(pkgDir1, { recursive: true });
    writeFileSync(join(pkgDir1, "package.json"), JSON.stringify({ version: "1.0.0" }));

    const { observeGroup } = await import("./deps.js");
    const obs = observeGroup("native");
    expect(obs.state).toBe("drifted");
  });
});

// ── resolveGroupActions ───────────────────────────────────────────────────────

describe("resolveGroupActions", () => {
  it("install with no args resolves to native group", async () => {
    const { resolveGroupActions } = await import("./deps.js");
    const actions = resolveGroupActions("install", []);
    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions.some(a => a.group === "native")).toBe(true);
  });

  it("install all resolves to missing action for every group", async () => {
    const { resolveGroupActions } = await import("./deps.js");
    const actions = resolveGroupActions("install", ["all"]);
    // All groups are absent, so each gets a "missing" action
    const allCount = Object.keys((await import("../../utils/lazy-require.js")).OPTIONAL_DEPS).length;
    expect(actions.length).toBe(allCount);
    expect(actions.every(a => a.reason === "missing")).toBe(true);
  });

  it("rejects unknown group", async () => {
    const { resolveGroupActions } = await import("./deps.js");
    expect(() => resolveGroupActions("install", ["nope"])).toThrow(/Unknown dep/);
  });

  it("deduplicates repeated names", async () => {
    const { resolveGroupActions } = await import("./deps.js");
    const actions = resolveGroupActions("install", ["pdf", "pdf"]);
    // Should only mention pdf once
    expect(actions.filter(a => a.group === "pdf").length).toBe(1);
  });

  it("update with no args returns empty when nothing installed", async () => {
    const { resolveGroupActions } = await import("./deps.js");
    const actions = resolveGroupActions("update", []);
    // All groups absent → silently skipped
    expect(actions.length).toBe(0);
  });

  it("update with no args refreshes installed groups", async () => {
    // Install pdf-parse so the "pdf" group appears ready
    const pkgDir = join(tmpDir, ".local", "lib", "node_modules", "pdf-parse");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "latest" }));

    const { resolveGroupActions } = await import("./deps.js");
    const actions = resolveGroupActions("update", []);
    // pdf should be present with a refresh action
    expect(actions.some(a => a.group === "pdf" && a.reason === "refresh")).toBe(true);
  });

  it("update on absent group produces missing action", async () => {
    const { resolveGroupActions } = await import("./deps.js");
    const actions = resolveGroupActions("update", ["pdf"]);
    expect(actions.some(a => a.group === "pdf" && a.reason === "missing")).toBe(true);
  });
});

// ── CLI integration ──────────────────────────────────────────────────────────

describe("abtars deps", () => {
  it("list shows all optional deps", async () => {
    const { deps } = await import("./deps.js");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await deps(["list"]);
    expect(code).toBe(0);
    const output = write.mock.calls.map(c => c[0]).join("");
    expect(output).toContain("pdf");
    expect(output).toContain("youtube");
    expect(output).toContain("image");
    write.mockRestore();
  });

  it("install unknown dep returns error", async () => {
    const { deps } = await import("./deps.js");
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await deps(["install", "nonexistent"]);
    expect(code).toBe(1);
    const output = write.mock.calls.map(c => c[0]).join("");
    expect(output).toContain("Unknown dep");
    write.mockRestore();
  });

  it("install of a system binary prints its manual hint", async () => {
    const { deps } = await import("./deps.js");
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await deps(["install", "ollama"]);
    expect(code).toBe(0);
    const stdout = out.mock.calls.map(c => c[0]).join("");
    expect(stdout).toContain("system binary");
    expect(stdout).toContain("ollama.ai/install.sh");
    out.mockRestore();
  });

  it("install with no args defaults to native group", async () => {
    // Pre-create native packages at their exact targets so they appear "ready"
    const versions: Record<string, string> = { "better-sqlite3": "12.11.1", "sqlite-vec": "0.1.9" };
    for (const pkg of ["better-sqlite3", "sqlite-vec"]) {
      const pkgDir = join(tmpDir, ".local", "lib", "node_modules", pkg);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: versions[pkg] }));
    }
    let manifest = createEmptyManifest();
    for (const pkg of ["better-sqlite3", "sqlite-vec"] as const) {
      manifest = upsertRecord(manifest, pkg, {
        version: versions[pkg], nodeAbi: process.versions.modules, nodeVersion: process.version,
        platform: process.platform, arch: process.arch, contentHash: "test", installedAt: new Date().toISOString(),
        installedBy: "abtars", consumers: ["abtars"], probe: pkg === "better-sqlite3" ? "sqlite-open-select-v1" : "sqlite-vec-load-query-v1",
      });
    }
    writeManifest(manifest);

    const { deps } = await import("./deps.js");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await deps(["install"]);
    expect(code).toBe(0);
    const output = write.mock.calls.map(c => c[0]).join("");
    expect(output).toContain("already up to date");
    write.mockRestore();
  });

  it("list shows target version and observed version", async () => {
    // Install a package at a known version
    const pkgDir = join(tmpDir, ".local", "lib", "node_modules", "pdf-parse");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "1.0.0" }));

    const { deps } = await import("./deps.js");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await deps(["list"]);
    expect(code).toBe(0);
    const output = write.mock.calls.map(c => c[0]).join("");
    expect(output).toContain("1.0.0");
    write.mockRestore();
  });
});
