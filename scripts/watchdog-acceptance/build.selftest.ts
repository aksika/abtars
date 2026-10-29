/**
 * Focused harness self-tests: timing adapter and build isolation (#1712
 * Task 2). Proves transform count-checking aborts on drift and that builds
 * never touch the repository tree.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyTransforms, getProfile, SuiteBuilder, TransformMismatchError } from "./build.ts";

const REPO_ROOT = resolve(__dirname, "..", "..");

describe("timing adapter", () => {
  it("aborts setup when a watchdog constant drifts (zero matches)", () => {
    const drifted = "STALE=999        # heartbeat staleness threshold (seconds)";
    expect(() => applyTransforms(drifted, getProfile("lifecycle").transforms, "watchdog")).toThrow(TransformMismatchError);
  });

  it("aborts setup when a pattern unexpectedly repeats (multiple matches)", () => {
    const duplicated = "STALE=300\nSTALE=300";
    expect(() => applyTransforms(duplicated, getProfile("lifecycle").transforms, "watchdog")).toThrow(TransformMismatchError);
  });

  it("compresses every declared constant exactly once", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts/abtars-watchdog.sh"), "utf-8");
    const out = applyTransforms(source, getProfile("staleFast").transforms, "watchdog");
    expect(out).toContain("STALE=3");
    expect(out).toContain("POLL=2 ");
    expect(out).toContain("POLL_INTERVAL=0.3");
    expect(out).toContain("SPAWNED_AT < 1");
    expect(out).not.toContain("STALE=300");
  });

  it("patches the backoff table in the supervisor-state bundle input only", () => {
    const source = readFileSync(join(REPO_ROOT, "src/supervisor/state.ts"), "utf-8");
    const out = applyTransforms(source, getProfile("crashLoopFast").transforms, "supervisor-state");
    expect(out).toContain("[0, 120, 120, 120, 120, 120]");
    // The repository file itself is untouched.
    expect(source).toContain("[0, 2000, 5000, 15000, 30000, 60000]");
  });
});

describe("SuiteBuilder", () => {
  it("produces artifacts without changing the repository tree", async () => {
    const gitBefore = execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf-8" });
    const artifacts = mkdtempSync(join(tmpdir(), "wd-acc-selftest-"));
    try {
      const builder = new SuiteBuilder(REPO_ROOT, artifacts);
      builder.prepare();
      await builder.prebuild(["crashLoopFast"]);
      const wd = readFileSync(builder.produceWatchdogCopy("crashLoopFast"), "utf-8");
      expect(wd).toContain("STALE=5");
      const cli = readFileSync(builder.bundleSupervisorState("crashLoopFast"), "utf-8");
      expect(cli.length).toBeGreaterThan(1000);
      const fixture = readFileSync(builder.bundleFixtureBridge(), "utf-8");
      expect(fixture).toContain("initBridgeLock");
      const gitAfter = execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf-8" });
      expect(gitAfter).toBe(gitBefore);
    } finally {
      rmSync(artifacts, { recursive: true, force: true });
    }
  }, 60000);

  it("refuses sync access before prebuild", () => {
    const artifacts = mkdtempSync(join(tmpdir(), "wd-acc-selftest2-"));
    try {
      const builder = new SuiteBuilder(REPO_ROOT, artifacts);
      expect(() => builder.bundleSupervisorState("lifecycle")).toThrow(/prebuilt/);
    } finally {
      rmSync(artifacts, { recursive: true, force: true });
    }
  });
});
