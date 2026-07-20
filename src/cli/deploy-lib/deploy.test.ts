import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLaunchctlBootstrap, deployActivation } from "./deploy.js";
import type { BootstrapFn } from "./deploy.js";
import type { StagedRelease } from "../update-sources/types.js";

// ── runLaunchctlBootstrap ───────────────────────────────────────────────────

describe("deploy-lib/runLaunchctlBootstrap", () => {
  it("returns ok when spawnSync status is 0", () => {
    const mockSpawnSync = () => ({ status: 0, stderr: Buffer.from(""), stdout: Buffer.from("") });
    const result = runLaunchctlBootstrap("gui/501", "/tmp/test.plist", mockSpawnSync as any);
    expect(result.ok).toBe(true);
    expect((result as any).error).toBeUndefined();
  });

  it("returns failed with stderr detail when status is non-zero", () => {
    const mockSpawnSync = () => ({
      status: 1,
      stderr: Buffer.from("domain gui/501 is already bootstrapped"),
      stdout: Buffer.from(""),
    });
    const result = runLaunchctlBootstrap("gui/501", "/tmp/test.plist", mockSpawnSync as any);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("already bootstrapped");
  });

  it("returns failed with error message when spawnSync throws", () => {
    const mockSpawnSync = () => { throw new Error("ETIMEDOUT: launchctl bootstrap"); };
    const result = runLaunchctlBootstrap("gui/501", "/tmp/test.plist", mockSpawnSync as any);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("ETIMEDOUT");
  });

  it("passes correct argv to launchctl", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockSpawnSync = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { status: 0, stderr: Buffer.from(""), stdout: Buffer.from("") };
    };
    runLaunchctlBootstrap("gui/501", "/tmp/test.plist", mockSpawnSync as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("launchctl");
    expect(calls[0]!.args).toEqual(["bootstrap", "gui/501", "/tmp/test.plist"]);
  });
});

// ── deployActivation ────────────────────────────────────────────────────────

interface HealthProbeResult {
  healthy: boolean;
  pid?: number;
  heartbeat?: number | null;
}

function makeHealthMock() {
  const calls: Array<{ home: string; since: number; timeout: number }> = [];
  const fn = (home: string, since: number, timeout: number) => {
    calls.push({ home, since, timeout });
    return Promise.resolve({ healthy: true, pid: 12345, heartbeat: Date.now() });
  };
  return { fn: fn as (home: string, since: number, timeout: number) => Promise<HealthProbeResult>, calls };
}

let tmp: string;
let releasesTmp: string;
let staged: StagedRelease;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "deploy-test-"));
  releasesTmp = mkdtempSync(join(tmpdir(), "deploy-releases-"));

  process.env["ABTARS_HOME"] = tmp;
  process.env["ABTARS_RELEASES"] = releasesTmp;

  // Minimal staged release
  const stagedPath = join(tmp, "staged");
  mkdirSync(join(stagedPath, "bundle"), { recursive: true });
  writeFileSync(join(stagedPath, "bundle", "abtars.js"), "// mock entry point");
  writeFileSync(join(stagedPath, "install-manifest.json"), JSON.stringify({
    cliWrappers: [],
    directories: [],
    configSeeds: [],
    manifestVersion: 1,
    lazyRoots: [],
  }));

  // Non-first-install — manifest exists
  writeFileSync(join(tmp, "manifest.json"), JSON.stringify({ version: "1.0.0" }));

  // Releases dir with history
  writeFileSync(join(releasesTmp, "history.json"), JSON.stringify(["prev-version"]));

  staged = {
    version: "1.0.0-test",
    commit: "abc1234",
    branch: "dev",
    stagedPath,
    packageLockHash: "hash123",
  } as StagedRelease;
});

afterEach(() => {
  delete process.env["ABTARS_HOME"];
  delete process.env["ABTARS_RELEASES"];
  rmSync(tmp, { recursive: true, force: true });
  rmSync(releasesTmp, { recursive: true, force: true });
});

describe("deployActivation — bootstrap failure (macOS)", () => {
  const origPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true, writable: true });
  });

  it("returns 1 and writes failed deploy.state when launchctl bootstrap fails", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    const bootstrapFn: BootstrapFn = () => ({ ok: false, error: "launchctl: WorkQueue is already bootstrapped" });
    const healthMock = makeHealthMock();

    const code = await deployActivation({ staged, channel: "npm", repoRoot: tmp }, bootstrapFn, healthMock.fn);

    expect(code).toBe(1);
    const state = JSON.parse(readFileSync(join(tmp, "deploy.state"), "utf-8")) as Record<string, unknown>;
    expect(state.status).toBe("failed");
    expect((state.error as string).length).toBeLessThanOrEqual(300);
    expect(state.version).toBe("1.0.0-test");
  });

  it("skips health probe when bootstrap fails", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    const healthMock = makeHealthMock();
    const bootstrapFn: BootstrapFn = () => ({ ok: false, error: "bootstrap failed" });

    await deployActivation({ staged, channel: "npm", repoRoot: tmp }, bootstrapFn, healthMock.fn);

    expect(healthMock.calls).toHaveLength(0);
  });
});

describe("deployActivation — bootstrap success + health healthy (macOS)", () => {
  const origPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true, writable: true });
  });

  it("returns 0 and writes success deploy.state", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    const bootstrapFn: BootstrapFn = () => ({ ok: true });
    const healthMock = makeHealthMock();

    const code = await deployActivation({ staged, channel: "npm", repoRoot: tmp }, bootstrapFn, healthMock.fn);

    expect(code).toBe(0);
    expect(healthMock.calls).toHaveLength(1);
    const state = JSON.parse(readFileSync(join(tmp, "deploy.state"), "utf-8")) as Record<string, unknown>;
    expect(state.status).toBe("success");
  });
});

describe("deployActivation — health unhealthy (Linux)", () => {
  it("returns 0 on Linux (unchanged behavior)", { timeout: 30000 }, async () => {
    const unhealthyProbe: (...args: any[]) => Promise<{ healthy: false }> = async () => ({ healthy: false });
    const bootstrapFn: BootstrapFn = () => ({ ok: true });

    const code = await deployActivation({ staged, channel: "npm", repoRoot: tmp }, bootstrapFn, unhealthyProbe);

    expect(code).toBe(0);
    const state = JSON.parse(readFileSync(join(tmp, "deploy.state"), "utf-8")) as Record<string, unknown>;
    expect(state.status).toBe("unhealthy");
  });
});

describe("deployActivation — health unhealthy (macOS)", () => {
  const origPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true, writable: true });
  });

  it("returns 1 on macOS when health probe fails", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    const unhealthyProbe: (...args: any[]) => Promise<{ healthy: false }> = async () => ({ healthy: false });
    const bootstrapFn: BootstrapFn = () => ({ ok: true });

    const code = await deployActivation({ staged, channel: "npm", repoRoot: tmp }, bootstrapFn, unhealthyProbe);

    expect(code).toBe(1);
    const state = JSON.parse(readFileSync(join(tmp, "deploy.state"), "utf-8")) as Record<string, unknown>;
    expect(state.status).toBe("unhealthy");
  });
});
