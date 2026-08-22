import { describe, it, expect, beforeEach, afterEach } from "vitest";

const TIMEOUT = 60000;
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isExpectedWatchdogAbsence, runLaunchctlBootstrap, deployActivation, startSystemdWatchdog } from "./deploy.js";
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

describe("deploy-lib/isExpectedWatchdogAbsence", () => {
  it("recognizes launchd's already-absent No such process response", () => {
    const err = Object.assign(new Error("launchctl bootout failed"), {
      stderr: Buffer.from("Boot-out failed: 3: No such process"),
    });

    expect(isExpectedWatchdogAbsence(err)).toBe(true);
  });
});

describe("deploy-lib/startSystemdWatchdog", () => {
  it("runs the complete Linux service-start sequence", () => {
    const calls: string[] = [];
    const result = startSystemdWatchdog(((command: string) => {
      calls.push(command);
    }) as any);

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      "systemctl --user unmask abtars-watchdog",
      "systemctl --user enable abtars-watchdog",
      "systemctl --user start abtars-watchdog",
    ]);
  });

  it("returns the failed operation instead of claiming the daemon started", () => {
    const result = startSystemdWatchdog(((command: string) => {
      if (command.endsWith("start abtars-watchdog")) throw new Error("unit failed to start");
    }) as any);

    expect(result).toEqual({ ok: false, error: "start watchdog unit: unit failed to start" });
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

  it("returns 1 and writes failed deploy.state when launchctl bootstrap fails", { timeout: TIMEOUT }, async () => {
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

  it("skips health probe when bootstrap fails", { timeout: TIMEOUT }, async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    const healthMock = makeHealthMock();
    const bootstrapFn: BootstrapFn = () => ({ ok: false, error: "bootstrap failed" });

    await deployActivation({ staged, channel: "npm", repoRoot: tmp }, bootstrapFn, healthMock.fn);

    expect(healthMock.calls).toHaveLength(0);
  });

  it("does not overwrite corrupt release history", { timeout: TIMEOUT }, async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    const corruptHistory = "{not-json\n";
    writeFileSync(join(releasesTmp, "history.json"), corruptHistory);
    const bootstrapFn: BootstrapFn = () => ({ ok: true });
    const healthMock = makeHealthMock();

    const code = await deployActivation({ staged, channel: "npm", repoRoot: tmp }, bootstrapFn, healthMock.fn);

    expect(code).toBe(1);
    expect(readFileSync(join(releasesTmp, "history.json"), "utf-8")).toBe(corruptHistory);
    expect(healthMock.calls).toHaveLength(0);
  });
});

describe("deployActivation — bootstrap success + health healthy (macOS)", () => {
  const origPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true, writable: true });
  });

  it("returns 0 and writes success deploy.state", { timeout: TIMEOUT }, async () => {
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

    const code = await deployActivation({ staged, channel: "npm", repoRoot: tmp }, bootstrapFn, unhealthyProbe, () => ({ ok: true }), () => {});

    expect(code).toBe(0);
    const state = JSON.parse(readFileSync(join(tmp, "deploy.state"), "utf-8")) as Record<string, unknown>;
    expect(state.status).toBe("unhealthy");
  });
});

// ── Skill dependency preparation during activation (#1542) ─────────────────

const FAKE_NPM = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (process.env.FAKE_NPM_LOG) {
  fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + "\\n");
}
const prefix = args[args.indexOf("--prefix") + 1];
if (process.env.FAKE_NPM_FAIL === "1") { console.error("fake npm: forced failure"); process.exit(1); }
for (const pin of args.filter(a => !a.startsWith("-"))) {
  const at = pin.lastIndexOf("@");
  const name = pin.slice(0, at);
  const version = pin.slice(at + 1);
  const dir = path.join(prefix, "node_modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version, type: "module", exports: { ".": "./index.js" } }));
  fs.writeFileSync(path.join(dir, "index.js"), "export const VALUE = 1;\\n");
}
`;

describe("deployActivation — #1542 skill dependency preparation", () => {
  let fakeNpm: string;

  function seedStagedSkill(name: string, deps: Record<string, string>): void {
    const dir = join(tmp, "staged", "templates", "skills", name);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: staged fixture skill\n---\n`);
    writeFileSync(join(dir, "scripts", "package.json"), JSON.stringify({ type: "module", dependencies: deps }, null, 2));
  }

  beforeEach(() => {
    fakeNpm = join(tmp, "fake-npm");
    writeFileSync(fakeNpm, FAKE_NPM);
    chmodSync(fakeNpm, 0o755);
    process.env.ABTARS_SKILL_NPM_BIN = fakeNpm;
  });

  afterEach(() => {
    delete process.env.ABTARS_SKILL_NPM_BIN;
    delete process.env.FAKE_NPM_LOG;
    delete process.env.FAKE_NPM_FAIL;
  });

  it("prepares staged core dependencies before activation and admits the skill", { timeout: TIMEOUT }, async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    const log = join(tmp, "npm.log");
    process.env.FAKE_NPM_LOG = log;
    seedStagedSkill("fixture-skill", { "fixture-pkg": "1.2.3" });
    const healthMock = makeHealthMock();
    const bootstrapFn: BootstrapFn = () => ({ ok: true });

    const code = await deployActivation({ staged, channel: "npm", repoRoot: tmp }, bootstrapFn, healthMock.fn);

    expect(code).toBe(0);
    // Declared exact pin installed under the dependency root.
    const installed = JSON.parse(readFileSync(join(tmp, "node_modules", "fixture-pkg", "package.json"), "utf-8")) as { version: string };
    expect(installed.version).toBe("1.2.3");
    // Reconcile copied staged core into the runtime tree.
    expect(existsSync(join(tmp, "skills", "core", "fixture-skill", "SKILL.md"))).toBe(true);
    // Exactly one npm invocation with exact name@version argv.
    const argv = JSON.parse(readFileSync(log, "utf-8").trim()) as string[];
    expect(argv).toContain("fixture-pkg@1.2.3");
  });

  it("aborts before any activation mutation when a staged declaration is invalid", { timeout: TIMEOUT }, async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    seedStagedSkill("bad-skill", { "fixture-pkg": "^1.2.3" });
    const healthMock = makeHealthMock();
    const bootstrapFn: BootstrapFn = () => ({ ok: true });

    const code = await deployActivation({ staged, channel: "npm", repoRoot: tmp }, bootstrapFn, healthMock.fn);

    expect(code).toBe(1);
    // No release dir, no history mutation, no repointed symlink, no npm work.
    expect(existsSync(join(releasesTmp, "abc1234"))).toBe(false);
    expect(readFileSync(join(releasesTmp, "history.json"), "utf-8")).toContain("prev-version");
    expect(existsSync(join(releasesTmp, "current"))).toBe(false);
    expect(existsSync(join(tmp, "node_modules"))).toBe(false);
    expect(healthMock.calls).toHaveLength(0);
  });

  it("aborts before activation when npm fails, leaving release/history unchanged", { timeout: TIMEOUT }, async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    process.env.FAKE_NPM_FAIL = "1";
    seedStagedSkill("needy-skill", { "fixture-pkg": "1.2.3" });
    const healthMock = makeHealthMock();
    const bootstrapFn: BootstrapFn = () => ({ ok: true });

    const code = await deployActivation({ staged, channel: "npm", repoRoot: tmp }, bootstrapFn, healthMock.fn);

    expect(code).toBe(1);
    expect(existsSync(join(releasesTmp, "abc1234"))).toBe(false);
    expect(readFileSync(join(releasesTmp, "history.json"), "utf-8")).toContain("prev-version");
    expect(healthMock.calls).toHaveLength(0);
  });
});

describe("deployActivation — health unhealthy (macOS)", () => {
  const origPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true, writable: true });
  });

  it("returns 1 on macOS when health probe fails", { timeout: TIMEOUT }, async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    const unhealthyProbe: (...args: any[]) => Promise<{ healthy: false }> = async () => ({ healthy: false });
    const bootstrapFn: BootstrapFn = () => ({ ok: true });

    const code = await deployActivation({ staged, channel: "npm", repoRoot: tmp }, bootstrapFn, unhealthyProbe);

    expect(code).toBe(1);
    const state = JSON.parse(readFileSync(join(tmp, "deploy.state"), "utf-8")) as Record<string, unknown>;
    expect(state.status).toBe("unhealthy");
  });
});
