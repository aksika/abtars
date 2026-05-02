import { describe, it, expect, beforeEach } from "vitest";
import { loadManifest, _resetManifestCache, isLazyRootAllowed, reconcileManifest } from "./install-manifest.js";
import type { InstallManifest } from "./install-manifest.js";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_HOME = join(tmpdir(), `ab-manifest-test-${process.pid}`);
const TEST_REPO = join(tmpdir(), `ab-manifest-repo-${process.pid}`);

beforeEach(() => {
  _resetManifestCache();
  rmSync(TEST_HOME, { recursive: true, force: true });
  rmSync(TEST_REPO, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
  mkdirSync(TEST_REPO, { recursive: true });
});

describe("loadManifest", () => {
  it("loads manifest from repo root", () => {
    const m = loadManifest();
    expect(m.manifestVersion).toBe(2);
    expect(m.directories.length).toBeGreaterThan(0);
    expect(m.lazyRoots.length).toBeGreaterThan(0);
    expect(m.cliWrappers).toContain("abtars");
  });
});

describe("isLazyRootAllowed", () => {
  const manifest = { lazyRoots: ["reports", "skills", "memory"] } as InstallManifest;

  it("allows exact root", () => {
    expect(isLazyRootAllowed(manifest, "reports")).toBe(true);
  });

  it("allows subpath", () => {
    expect(isLazyRootAllowed(manifest, "skills/core")).toBe(true);
    expect(isLazyRootAllowed(manifest, "reports/tasks/daily")).toBe(true);
  });

  it("rejects undeclared path", () => {
    expect(isLazyRootAllowed(manifest, "undeclared")).toBe(false);
    expect(isLazyRootAllowed(manifest, "reportsX")).toBe(false);
  });
});

describe("reconcileManifest", () => {
  const manifest: InstallManifest = {
    manifestVersion: 2,
    directories: [
      { path: "config", mode: "0700" },
      { path: "logs" },
    ],
    lazyRoots: [],
    configSeeds: [
      { source: "test.env.example", dest: "config/.env", mode: "0600" },
    ],
    requiredConfigs: [
      { path: "config/transport.json", remediation: "run onboard" },
    ],
    scripts: { include: [], executable: "*.sh" },
    services: { supervised: {} },
    cliWrappers: [],
    postInstall: [],
  };

  it("reports missing dirs in diff mode", () => {
    const result = reconcileManifest(manifest, TEST_HOME, TEST_REPO, false);
    expect(result.warnings).toContain("config/ MISSING");
    expect(result.warnings).toContain("logs/ MISSING");
  });

  it("creates missing dirs in fix mode", () => {
    const result = reconcileManifest(manifest, TEST_HOME, TEST_REPO, true);
    expect(result.fixed).toContain("created config/");
    expect(result.fixed).toContain("created logs/");
    expect(existsSync(join(TEST_HOME, "config"))).toBe(true);
    expect(existsSync(join(TEST_HOME, "logs"))).toBe(true);
  });

  it("seeds missing config in fix mode", () => {
    mkdirSync(join(TEST_HOME, "config"), { recursive: true });
    mkdirSync(join(TEST_HOME, "logs"), { recursive: true });
    writeFileSync(join(TEST_REPO, "test.env.example"), "KEY=value\n");
    const result = reconcileManifest(manifest, TEST_HOME, TEST_REPO, true);
    expect(result.fixed.some(f => f.includes("seeded config/.env"))).toBe(true);
    expect(existsSync(join(TEST_HOME, "config/.env"))).toBe(true);
  });

  it("reports missing required config", () => {
    mkdirSync(join(TEST_HOME, "config"), { recursive: true });
    mkdirSync(join(TEST_HOME, "logs"), { recursive: true });
    const result = reconcileManifest(manifest, TEST_HOME, TEST_REPO, false);
    expect(result.warnings.some(w => w.includes("transport.json") && w.includes("run onboard"))).toBe(true);
  });

  it("reports ok for existing dirs", () => {
    mkdirSync(join(TEST_HOME, "config"), { recursive: true, mode: 0o700 });
    mkdirSync(join(TEST_HOME, "logs"), { recursive: true });
    const result = reconcileManifest(manifest, TEST_HOME, TEST_REPO, false);
    expect(result.ok).toContain("config/");
    expect(result.ok).toContain("logs/");
  });
});
