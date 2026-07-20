import { describe, it, expect } from "vitest";
import { runLaunchctlBootstrap } from "./deploy.js";
import type { BootstrapResult, BootstrapFn } from "./deploy.js";

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
