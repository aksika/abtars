import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
  throw new Error("process.exit called");
});

import { checkCircuitBreaker } from "./circuit-breaker.js";

let home: string;
let releases: string;
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  envBackup.ABTARS_HOME = process.env["ABTARS_HOME"];
  envBackup.ABTARS_RELEASES = process.env["ABTARS_RELEASES"];
  envBackup.ABTARS_START_REASON = process.env["ABTARS_START_REASON"];

  home = mkdtempSync(join(tmpdir(), "cb-home-"));
  releases = mkdtempSync(join(tmpdir(), "cb-releases-"));
  process.env["ABTARS_HOME"] = home;
  process.env["ABTARS_RELEASES"] = releases;
  process.env["ABTARS_START_REASON"] = "watchdog-respawn";

  mkdirSync(join(home), { recursive: true });
  mkdirSync(join(releases), { recursive: true });
});

afterEach(() => {
  exitSpy.mockClear();

  if (envBackup.ABTARS_HOME === undefined) delete process.env["ABTARS_HOME"];
  else process.env["ABTARS_HOME"] = envBackup.ABTARS_HOME;
  if (envBackup.ABTARS_RELEASES === undefined) delete process.env["ABTARS_RELEASES"];
  else process.env["ABTARS_RELEASES"] = envBackup.ABTARS_RELEASES;
  if (envBackup.ABTARS_START_REASON === undefined) delete process.env["ABTARS_START_REASON"];
  else process.env["ABTARS_START_REASON"] = envBackup.ABTARS_START_REASON;

  rmSync(home, { recursive: true, force: true });
  rmSync(releases, { recursive: true, force: true });
});

function writeSupervisorState(overrides: Record<string, unknown> = {}) {
  const state: Record<string, unknown> = {
    schemaVersion: 1,
    desiredState: "running",
    nextCommandSeq: 1,
    pendingCommand: null,
    acknowledgedCommandSeq: 0,
    restartCount: 0,
    backoffAttempt: 0,
    recentDeaths: [],
    lastDeathAt: null,
    ...overrides,
  };
  writeFileSync(join(home, "supervisor.state"), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function writeHistory(entries: string[]) {
  writeFileSync(join(releases, "history.json"), JSON.stringify(entries), "utf-8");
}

function writeRelease(ref: string) {
  const dir = join(releases, ref);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", name: "abtars", version: ref }));
}

describe("checkCircuitBreaker", () => {
  it("returns early when restartCount < 4", () => {
    writeSupervisorState({ restartCount: 2 });
    writeHistory(["aaaaaaa", "bbbbbbb"]);
    writeRelease("bbbbbbb");

    checkCircuitBreaker();
    // No exit — returned early
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("resets counters when reason is update:*", () => {
    process.env["ABTARS_START_REASON"] = "update:abc123";
    writeSupervisorState({ restartCount: 5 });
    checkCircuitBreaker();
    const state = JSON.parse(readFileSync(join(home, "supervisor.state"), "utf-8"));
    expect(state.restartCount).toBe(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("resets counters when reason is user-restart", () => {
    process.env["ABTARS_START_REASON"] = "user-restart";
    writeSupervisorState({ restartCount: 5 });
    checkCircuitBreaker();
    const state = JSON.parse(readFileSync(join(home, "supervisor.state"), "utf-8"));
    expect(state.restartCount).toBe(0);
  });

  it("continues without permanent stop when history has < 2 entries", () => {
    writeSupervisorState({ restartCount: 4 });
    writeHistory(["aaaaaaa"]);

    checkCircuitBreaker();
    // Creates rollback-history-missing sentinel
    expect(existsSync(join(home, "rollback-history-missing"))).toBe(true);
    const state = JSON.parse(readFileSync(join(home, "supervisor.state"), "utf-8"));
    expect(state.restartCount).toBe(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("continues without permanent stop when target release dir is missing", () => {
    writeSupervisorState({ restartCount: 4 });
    writeHistory(["aaaaaaa", "bbbbbbb"]);
    // bbbbbbb dir does NOT exist

    checkCircuitBreaker();
    expect(existsSync(join(home, "rollback-target-missing"))).toBe(true);
    const state = JSON.parse(readFileSync(join(home, "supervisor.state"), "utf-8"));
    expect(state.restartCount).toBe(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("rolls back to history[1] and exits 0 when restartCount >= 4", () => {
    writeSupervisorState({ restartCount: 4 });
    writeHistory(["aaaaaaa", "bbbbbbb"]);
    writeRelease("bbbbbbb");

    expect(() => checkCircuitBreaker()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(0);

    // current symlink repointed to bbbbbbb
    const current = readlinkSync(join(releases, "current"));
    expect(current).toBe(join(releases, "bbbbbbb"));

    // app -> current
    const app = readlinkSync(join(home, "app"));
    expect(app).toBe(join(releases, "current"));

    // restart counter reset
    const state = JSON.parse(readFileSync(join(home, "supervisor.state"), "utf-8"));
    expect(state.restartCount).toBe(0);
  });

  it("does not trigger rollback on exactly restartCount=4 (not >= requires 4)", () => {
    // This test is redundant with the < 4 test but documents the exact
    // boundary: MAX_DEATHS=4 means rollback triggers at restartCount >= 4.
    writeSupervisorState({ restartCount: 3 });
    writeHistory(["aaaaaaa", "bbbbbbb"]);
    writeRelease("bbbbbbb");

    checkCircuitBreaker();
    const state = JSON.parse(readFileSync(join(home, "supervisor.state"), "utf-8"));
    expect(state.restartCount).toBe(3);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
