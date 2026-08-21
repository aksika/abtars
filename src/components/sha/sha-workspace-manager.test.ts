import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ShaWorkspaceManager, type ExecFn } from "./sha-workspace-manager.js";
import { ShaKnownFixRunner, SHA_ALLOWED_EXECUTABLES } from "./sha-known-fix-runner.js";
import type { PiExecutorConfig } from "../pi-executor/config.js";

const savedHome = process.env["ABTARS_HOME"];
let tmpRoot: string;

function makeConfig(aliases: PiExecutorConfig["workspaceAliases"]): PiExecutorConfig {
  return {
    enabled: true,
    command: "pi",
    fixedArgs: [],
    workspaceAliases: aliases,
    allowedEnv: [],
    maxConcurrent: 1,
    maxWallClockMs: 1_800_000,
    abortGraceMs: 10_000,
    projectTrust: "never",
    sessionStorageRoot: join(tmpRoot, "state"),
  };
}

function makeExec(script: Record<string, { code?: number; stdout?: string; stderr?: string }>): { exec: ExecFn; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: ExecFn = async (cmd, args, _opts) => {
    calls.push({ cmd, args: [...args] });
    if (cmd === "git" && args[0] === "rev-parse") {
      const entry = script["git:rev-parse"];
      return { stdout: entry?.stdout ?? "0123456789abcdef\n", stderr: entry?.stderr ?? "", code: entry?.code ?? 0 };
    }
    if (cmd === "git" && args[0] === "status") {
      const entry = script["git:status"];
      return { stdout: entry?.stdout ?? "", stderr: entry?.stderr ?? "", code: entry?.code ?? 0 };
    }
    const entry = script[cmd] ?? { code: 0, stdout: "", stderr: "" };
    return { stdout: entry.stdout ?? "", stderr: entry.stderr ?? "", code: entry.code ?? 0 };
  };
  return { exec, calls };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sha-ws-"));
  process.env["ABTARS_HOME"] = join(tmpRoot, "abtars-home");
  mkdirSync(process.env["ABTARS_HOME"], { recursive: true });
  mkdirSync(join(process.env["ABTARS_HOME"], "config"), { recursive: true });
  mkdirSync(join(process.env["ABTARS_HOME"], "state"), { recursive: true });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env["ABTARS_HOME"];
  else process.env["ABTARS_HOME"] = savedHome;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ShaWorkspaceManager preflight (R7)", () => {
  it("rejects missing Pi config, missing alias, and non-never projectTrust", async () => {
    const manager = new ShaWorkspaceManager({ loadPiConfig: () => null });
    expect((await manager.preflight()).ok).toBe(false);

    const noAlias = new ShaWorkspaceManager({ loadPiConfig: () => makeConfig({}) });
    expect((await noAlias.preflight()).ok).toBe(false);

    const trustAlways = new ShaWorkspaceManager({
      loadPiConfig: () => makeConfig({ sha: { path: "/tmp/x", projectTrust: "always" } }),
    });
    const result = await trustAlways.preflight();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("projectTrust");
  });

  it("rejects the workspace inside, equal to, or containing a protected root", async () => {
    const home = process.env["ABTARS_HOME"]!;
    const inside = new ShaWorkspaceManager({ loadPiConfig: () => makeConfig({ sha: { path: join(home, "config", "x"), projectTrust: "never" } }) });
    expect((await inside.preflight()).ok).toBe(false);
    const equal = new ShaWorkspaceManager({ loadPiConfig: () => makeConfig({ sha: { path: home, projectTrust: "never" } }) });
    expect((await equal.preflight()).ok).toBe(false);
    const contains = new ShaWorkspaceManager({ loadPiConfig: () => makeConfig({ sha: { path: tmpRoot, projectTrust: "never" } }) });
    expect((await contains.preflight()).ok).toBe(false);
  });

  it("rejects non-Git and dirty workspaces; captures the baseline commit on success", async () => {
    const ws = join(tmpRoot, "sha-ws");
    mkdirSync(ws, { recursive: true });
    const { exec, calls } = makeExec({});
    const manager = new ShaWorkspaceManager({
      loadPiConfig: () => makeConfig({ sha: { path: ws, projectTrust: "never" } }),
      exec,
    });
    const notGit = await manager.preflight();
    expect(notGit.ok).toBe(false);
    if (!notGit.ok) expect(notGit.error).toContain("not a Git checkout");

    // Dirty workspace: .git exists as dir + status shows an entry.
    mkdirSync(join(ws, ".git"));
    const dirty = makeExec({ "git:status": { code: 0, stdout: " M file.txt\n" } });
    const dirtyManager = new ShaWorkspaceManager({
      loadPiConfig: () => makeConfig({ sha: { path: ws, projectTrust: "never" } }),
      exec: dirty.exec,
    });
    const dirtyResult = await dirtyManager.preflight();
    expect(dirtyResult.ok).toBe(false);
    if (!dirtyResult.ok) expect(dirtyResult.error).toContain("dirty");

    const clean = makeExec({ "git:rev-parse": { code: 0, stdout: "0123456789abcdef\n" } });
    const cleanManager = new ShaWorkspaceManager({
      loadPiConfig: () => makeConfig({ sha: { path: ws, projectTrust: "never" } }),
      exec: clean.exec,
    });
    const ok = await cleanManager.preflight();
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.baselineCommit).toBe("0123456789abcdef");
      expect(clean.calls.map((c) => c.cmd)).toEqual(["git", "git"]);
    }
  });
});

describe("ShaWorkspaceManager stage safety", () => {
  it("prepareStage resets and cleans only the validated path (TOCTOU revalidation)", async () => {
    const ws = join(tmpRoot, "sha-ws");
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(ws, ".git"));
    const { exec, calls } = makeExec({});
    const manager = new ShaWorkspaceManager({
      loadPiConfig: () => makeConfig({ sha: { path: ws, projectTrust: "never" } }),
      exec,
    });
    const preflight = await manager.preflight();
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    const result = await manager.prepareStage(preflight);
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.cmd + " " + c.args.join(" "))).toEqual([
      "git status --porcelain",
      "git rev-parse HEAD",
      "git rev-parse HEAD",
      "git reset --hard 0123456789abcdef",
      "git rev-parse HEAD",
      "git clean -fd",
    ]);
  });

  it("refuses destructive operations when HEAD moved or the path identity changed", async () => {
    const ws = join(tmpRoot, "sha-ws");
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(ws, ".git"));
    const { exec } = makeExec({});
    const manager = new ShaWorkspaceManager({
      loadPiConfig: () => makeConfig({ sha: { path: ws, projectTrust: "never" } }),
      exec,
    });
    const preflight = await manager.preflight();
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;

    const moved = makeExec({ "git:rev-parse": { code: 0, stdout: "deadbeef\n" } });
    const movedManager = new ShaWorkspaceManager({
      loadPiConfig: () => makeConfig({ sha: { path: ws, projectTrust: "never" } }),
      exec: moved.exec,
    });
    const refused = await movedManager.prepareStage(preflight);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("HEAD moved");
  });

  it("assertAnalysisClean passes on empty porcelain and fails on mutation", async () => {
    const ws = join(tmpRoot, "sha-ws");
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(ws, ".git"));
    const preflight = await new ShaWorkspaceManager({
      loadPiConfig: () => makeConfig({ sha: { path: ws, projectTrust: "never" } }),
      exec: makeExec({}).exec,
    }).preflight();
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;

    const cleanManager = new ShaWorkspaceManager({
      loadPiConfig: () => makeConfig({ sha: { path: ws, projectTrust: "never" } }),
      exec: makeExec({}).exec,
    });
    expect((await cleanManager.assertAnalysisClean(preflight)).ok).toBe(true);

    const mutated = makeExec({});
    const dirtyManager = new ShaWorkspaceManager({
      loadPiConfig: () => makeConfig({ sha: { path: ws, projectTrust: "never" } }),
      exec: (async (cmd: string, args: readonly string[], opts: { cwd?: string; timeoutMs: number }) => {
        if (cmd === "git" && args[0] === "status") return { stdout: " M src/x.ts\n", stderr: "", code: 0 };
        return mutated.exec(cmd, args, opts);
      }) as ExecFn,
    });
    const failed = await dirtyManager.assertAnalysisClean(preflight);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toContain("mutated");
  });
});

describe("ShaKnownFixRunner (R8)", () => {
  it("eligibility requires verified + command + verifier, not suppress", () => {
    expect(ShaKnownFixRunner.executableRule({ pattern: "p", action: "run", command: ["git"], verifyCommand: ["git"], cooldownMin: 1, verified: true })).toBe(true);
    expect(ShaKnownFixRunner.executableRule({ pattern: "p", action: "run", command: ["git"], cooldownMin: 1, verified: true })).toBe(false);
    expect(ShaKnownFixRunner.executableRule({ pattern: "p", action: "run", command: ["git"], verifyCommand: ["git"], cooldownMin: 1 })).toBe(false);
    expect(ShaKnownFixRunner.executableRule({ pattern: "p", action: "suppress", command: ["git"], verifyCommand: ["git"], cooldownMin: 1, verified: true })).toBe(false);
  });

  it("action exit zero is executed, not fixed — verifier decides", async () => {
    const exec: ExecFn = async (cmd, args, _opts) => {
      if (cmd === "git" && args[0] === "action") return { stdout: "", stderr: "", code: 0, timedOut: false };
      if (cmd === "git" && args[0] === "verify") return { stdout: "", stderr: "", code: 1, timedOut: false };
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    };
    const runner = new ShaKnownFixRunner(exec);
    const outcome = await runner.execute({ pattern: "p", action: "run", command: ["git", "action"], verifyCommand: ["git", "verify"], cooldownMin: 1, verified: true });
    expect(outcome.state).toBe("known_fix_unverified");
    expect(outcome.action.ok).toBe(true);
    expect(outcome.verifier?.ok).toBe(false);
  });

  it("only action+verifier both zero records verified", async () => {
    const exec: ExecFn = async (_cmd, _args, _opts) => ({ stdout: "", stderr: "", code: 0, timedOut: false });
    const outcome = await new ShaKnownFixRunner(exec).execute({ pattern: "p", action: "run", command: ["git", "a"], verifyCommand: ["git", "v"], cooldownMin: 1, verified: true });
    expect(outcome.state).toBe("known_fix_verified");
  });

  it("action failure is failed; timeout is typed", async () => {
    const exec: ExecFn = async (_cmd, _args, _opts) => ({ stdout: "", stderr: "", code: null, timedOut: true });
    const outcome = await new ShaKnownFixRunner(exec).execute({ pattern: "p", action: "run", command: ["git", "a"], verifyCommand: ["git", "v"], cooldownMin: 1, verified: true });
    expect(outcome.state).toBe("known_fix_failed");
    expect(outcome.action.timedOut).toBe(true);
  });

  it("non-allowlisted executables are rejected without running", async () => {
    const exec: ExecFn = async (_cmd, _args, _opts) => ({ stdout: "", stderr: "", code: 0, timedOut: false });
    const outcome = await new ShaKnownFixRunner(exec).execute({ pattern: "p", action: "run", command: ["curl", "evil"], verifyCommand: ["git", "v"], cooldownMin: 1, verified: true });
    expect(outcome.state).toBe("known_fix_failed");
    expect(outcome.action.output).toContain("not allowlisted");
    expect(SHA_ALLOWED_EXECUTABLES).toContain("abtars-edit");
  });

  it("bounded output capture", async () => {
    const exec: ExecFn = async (_cmd, _args, _opts) => ({ stdout: "x".repeat(20_000), stderr: "", code: 0, timedOut: false });
    const outcome = await new ShaKnownFixRunner(exec).execute({ pattern: "p", action: "run", command: ["git", "a"], verifyCommand: ["git", "v"], cooldownMin: 1, verified: true });
    expect(outcome.action.output.length).toBeLessThanOrEqual(4000);
  });
});