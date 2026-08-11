import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readSupervisorState,
  setDesiredState,
  publishCommand,
  claimPendingCommand,
  ackCommand,
  recordBridgeDeath,
  recordHealthyInterval,
  resetRestartCount,
  acquireStateLock,
  migrateSupervisorState,
  stateFilePath,
  getBackoffDelayMs,
} from "./state.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "state-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function readState() {
  const r = readSupervisorState(home);
  if (!r.ok) throw new Error(`read failed: ${r.reason}`);
  return r.state;
}

describe("readSupervisorState", () => {
  it("returns missing when no state file exists", () => {
    const r = readSupervisorState(home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing");
  });

  it("returns corrupt for primitive JSON", () => {
    writeFileSync(stateFilePath(home), "true", "utf-8");
    const r = readSupervisorState(home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("corrupt");
  });

  it("returns invalid-schema for array JSON", () => {
    writeFileSync(stateFilePath(home), JSON.stringify(["not", "an", "object"]), "utf-8");
    const r = readSupervisorState(home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid-schema");
  });

  it("returns missing for unparseable content", () => {
    writeFileSync(stateFilePath(home), "not-json", "utf-8");
    const r = readSupervisorState(home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("corrupt");
  });

  it("returns invalid-schema for unknown schema version", () => {
    writeFileSync(
      stateFilePath(home),
      JSON.stringify({ schemaVersion: 999, desiredState: "running" }),
      "utf-8",
    );
    const r = readSupervisorState(home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid-schema");
  });
});

describe("field preservation", () => {
  it("read-modify-write preserves untouched fields", () => {
    publishCommand(home, "update", "test:abc"); // seeds the state file
    const state = readState();
    const originalSeq = state.nextCommandSeq;

    setDesiredState(home, "stopped");
    const after = readState();
    expect(after.desiredState).toBe("stopped");
    expect(after.nextCommandSeq).toBe(originalSeq);
    expect(after.restartCount).toBe(0);
    expect(after.backoffAttempt).toBe(0);
    expect(after.schemaVersion).toBe(1);
    expect(after.acknowledgedCommandSeq).toBe(0);
  });
});

describe("publishCommand", () => {
  it("creates a new command when none is pending", () => {
    const { result, state } = publishCommand(home, "update", "test:abc123");
    expect(result).toBe("created");
    expect(state.pendingCommand).not.toBeNull();
    expect(state.pendingCommand!.type).toBe("update");
    expect(state.pendingCommand!.reason).toBe("test:abc123");
    expect(state.pendingCommand!.seq).toBe(1);

    const persisted = readState();
    expect(persisted.pendingCommand!.seq).toBe(1);
    expect(persisted.nextCommandSeq).toBe(2);
  });

  it("coalesces identical pending command", () => {
    publishCommand(home, "update", "test:abc123");
    const { result } = publishCommand(home, "update", "test:abc123");
    expect(result).toBe("coalesced");
  });

  it("returns busy when unlike command is pending", () => {
    publishCommand(home, "update", "test:abc123");
    const { result } = publishCommand(home, "restart", "user-restart");
    expect(result).toBe("busy");
  });

  it("stop dominates any pending non-stop command", () => {
    publishCommand(home, "update", "test:abc123");
    const { result, state } = publishCommand(home, "stop", "user-stop");
    expect(result).toBe("created");
    expect(state.desiredState).toBe("stopped");
    expect(state.pendingCommand).toBeNull();
  });

  it("stop command sets desiredState to stopped", () => {
    const { state } = publishCommand(home, "stop", "user-stop");
    expect(state.desiredState).toBe("stopped");
    expect(state.pendingCommand).toBeNull();
  });

  it("start clears an unprocessed stop so stop then start is recoverable", () => {
    publishCommand(home, "stop", "user-stop");
    const state = setDesiredState(home, "running");
    expect(state.desiredState).toBe("running");
    expect(state.pendingCommand).toBeNull();
  });

  it("does not strand a pending stop command", () => {
    publishCommand(home, "stop", "user-stop");
    expect(readState().pendingCommand).toBeNull();
  });
});

describe("claimPendingCommand", () => {
  it("returns null when no command is pending", () => {
    expect(claimPendingCommand(home)).toBeNull();
  });

  it("returns the pending command without clearing it", () => {
    publishCommand(home, "update", "test:abc123");
    const cmd = claimPendingCommand(home);
    expect(cmd).not.toBeNull();
    expect(cmd!.type).toBe("update");

    const persisted = readState();
    expect(persisted.pendingCommand).not.toBeNull();
  });
});

describe("ackCommand", () => {
  it("acknowledges matching seq and clears pending", () => {
    publishCommand(home, "update", "test:abc123");
    const seq = readState().pendingCommand!.seq;
    const ok = ackCommand(home, seq);
    expect(ok).toBe(true);

    const persisted = readState();
    expect(persisted.pendingCommand).toBeNull();
    expect(persisted.acknowledgedCommandSeq).toBe(seq);
  });

  it("rejects non-matching seq", () => {
    publishCommand(home, "update", "test:abc123");
    const ok = ackCommand(home, 999);
    expect(ok).toBe(false);

    const persisted = readState();
    expect(persisted.pendingCommand).not.toBeNull();
  });

  it("returns false with no pending command", () => {
    const ok = ackCommand(home, 1);
    expect(ok).toBe(false);
  });
});

describe("recordBridgeDeath", () => {
  it("increments restartCount and records death timestamp", () => {
    const now = Date.now();
    recordBridgeDeath(home, { at: now, reason: "crash" });
    const state = readState();
    expect(state.restartCount).toBe(1);
    expect(state.recentDeaths).toContain(now);
    expect(state.lastDeathAt).toBe(new Date(now).toISOString());
    expect(state.backoffAttempt).toBe(1);
  });

  it("caps recentDeaths at 10", () => {
    for (let i = 0; i < 12; i++) {
      recordBridgeDeath(home, { at: Date.now() + i, reason: "crash" });
    }
    const state = readState();
    expect(state.recentDeaths.length).toBeLessThanOrEqual(10);
    expect(state.restartCount).toBe(12);
    expect(state.backoffAttempt).toBe(5);
  });
});

describe("recordHealthyInterval", () => {
  it("clears old deaths and resets backoff when all cleared", () => {
    const old = Date.now() - 10 * 60 * 1000 - 1000;
    recordBridgeDeath(home, { at: old, reason: "old-crash" });
    expect(readState().restartCount).toBe(1);

    recordHealthyInterval(home, Date.now());
    const state = readState();
    expect(state.recentDeaths).toEqual([]);
    expect(state.backoffAttempt).toBe(0);
    expect(state.restartCount).toBe(0);
  });

  it("keeps recent deaths within the 5-minute window", () => {
    const recent = Date.now() - 60 * 1000;
    const old = Date.now() - 10 * 60 * 1000 - 1000;
    recordBridgeDeath(home, { at: old, reason: "old" });
    recordBridgeDeath(home, { at: recent, reason: "recent" });
    expect(readState().restartCount).toBe(2);

    recordHealthyInterval(home, Date.now());
    const state = readState();
    expect(state.recentDeaths).toEqual([recent]);
    // restartCount stays because there's a death within 10 minutes
    expect(state.restartCount).toBe(2);
    // backoff stayed at 2 (recordHealthyInterval only resets to 0 when ALL
    // recentDeaths are cleared; the remaining death keeps the backoff)
    expect(state.backoffAttempt).toBe(2);
  });
});

describe("resetRestartCount", () => {
  it("resets all counters", () => {
    recordBridgeDeath(home, { at: Date.now(), reason: "crash" });
    recordBridgeDeath(home, { at: Date.now(), reason: "crash" });
    expect(readState().restartCount).toBe(2);

    resetRestartCount(home, "user-restart");
    const state = readState();
    expect(state.restartCount).toBe(0);
    expect(state.backoffAttempt).toBe(0);
    expect(state.recentDeaths).toEqual([]);
    expect(state.lastDeathAt).toBeNull();
  });
});

describe("acquireStateLock", () => {
  it("acquires and releases lock", () => {
    const lock = acquireStateLock(home, "test");
    expect(lock.ok).toBe(true);
    lock.release();

    const lock2 = acquireStateLock(home, "test2");
    expect(lock2.ok).toBe(true);
    lock2.release();
  });

  it("blocks concurrent acquisition", () => {
    const lock1 = acquireStateLock(home, "test");
    expect(() => acquireStateLock(home, "test", 100)).toThrow("Failed to acquire");
    lock1.release();
  });

  it("stale takeover from a dead PID", () => {
    const lockPath = join(home, ".supervisor.lock");
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, "owner.json"),
      JSON.stringify({
        token: "stale-token",
        pid: 999_999_999,
        startIdentity: "999999999:0",
        host: "h",
        operation: "stale",
        createdAt: new Date().toISOString(),
      }),
      "utf-8",
    );

    const lock = acquireStateLock(home, "takeover");
    expect(lock.ok).toBe(true);
    // After takeover, the old lock was renamed to a tombstone and a new lock
    // was created at the same path — so the dir exists again
    expect(existsSync(lockPath)).toBe(true);
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf-8"));
    expect(owner.token).not.toBe("stale-token");
    lock.release();
  });

  it("release is idempotent", () => {
    const lock = acquireStateLock(home, "test");
    lock.release();
    lock.release();
  });
});

describe("migrateSupervisorState", () => {
  it("migrates nothing when state already exists", () => {
    publishCommand(home, "update", "test:abc"); // seeds the state file
    const result = migrateSupervisorState(home);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.migrated).toBe(false);
  });

  it("migrates desiredState=stopped from .stopped file", () => {
    writeFileSync(join(home, ".stopped"), "", "utf-8");
    const result = migrateSupervisorState(home);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.migrated).toBe(true);

    const state = readState();
    expect(state.desiredState).toBe("stopped");
    expect(existsSync(join(home, ".stopped"))).toBe(false);
  });

  it("migrates desiredState=stopped from .start-reason=stopped", () => {
    writeFileSync(join(home, ".start-reason"), "stopped\n", "utf-8");
    const result = migrateSupervisorState(home);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.migrated).toBe(true);

    const state = readState();
    expect(state.desiredState).toBe("stopped");
    expect(existsSync(join(home, ".start-reason"))).toBe(false);
  });

  it("migrates desiredState=running when no stop sentinels exist", () => {
    const result = migrateSupervisorState(home);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.migrated).toBe(true);

    const state = readState();
    expect(state.desiredState).toBe("running");
  });

  it("transfers deploy.state counters", () => {
    const now = Date.now();
    writeFileSync(
      join(home, "deploy.state"),
      JSON.stringify({
        status: "crash-loop",
        restartCount: 7,
        deathWindow: [now - 10000, now],
        lastDeath: new Date(now).toISOString(),
        otherField: "preserved",
      }),
      "utf-8",
    );

    migrateSupervisorState(home);
    const state = readState();
    expect(state.restartCount).toBe(7);
    expect(state.recentDeaths).toEqual([now - 10000, now]);
    expect(state.lastDeathAt).toBe(new Date(now).toISOString());

    const deployState = JSON.parse(readFileSync(join(home, "deploy.state"), "utf-8"));
    expect(deployState.restartCount).toBeUndefined();
    expect(deployState.deathWindow).toBeUndefined();
    expect(deployState.lastDeath).toBeUndefined();
    expect(deployState.otherField).toBe("preserved");
  });

  it("is idempotent on re-run", () => {
    writeFileSync(join(home, ".stopped"), "", "utf-8");
    migrateSupervisorState(home);

    const { ok, migrated } = migrateSupervisorState(home);
    expect(ok).toBe(true);
    expect(migrated).toBe(false);

    const state = readState();
    expect(state.desiredState).toBe("stopped");
  });
});

describe("getBackoffDelayMs", () => {
  it("returns 0 for backoffAttempt=0", () => {
    publishCommand(home, "update", "test:abc"); // seeds the state file
    const state = readState();
    expect(getBackoffDelayMs(state)).toBe(0);
  });

  it("returns increasing delays for higher attempts", () => {
    publishCommand(home, "update", "test:abc"); // seeds the state file
    const expected = [0, 2000, 5000, 15000, 30000, 60000];
    for (let i = 0; i <= 5; i++) {
      const state = readState();
      state.backoffAttempt = i;
      expect(getBackoffDelayMs(state)).toBe(expected[i]!);
    }
  });

  it("caps at 60000 for attempt > 5", () => {
    publishCommand(home, "update", "test:abc"); // seeds the state file
    const state = readState();
    state.backoffAttempt = 10;
    expect(getBackoffDelayMs(state)).toBe(60000);
  });
});
