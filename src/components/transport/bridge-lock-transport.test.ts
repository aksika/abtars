/**
 * bridge-lock-transport.test.ts — #1632 regression guard.
 *
 * Molty 2026-08-10: an orphan bridge.lock.tmp from an interrupted deploy made
 * every atomicWriteSync to bridge.lock fail EEXIST. Two things broke, and only
 * the first was obvious:
 *
 *  1. initBridgeLock could not create the lock, so the bridge booted with no
 *     watchdog lifeline;
 *  2. updateLastHeartbeat writes through the same primitive, so the per-tick
 *     heartbeat silently stopped for the process lifetime. L3 watchdog.sh then
 *     saw a stale lastHeartbeat, declared a live bridge dead, and respawned it
 *     in a loop.
 *
 * These tests pin the L1 lifeline surviving that exact condition.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initBridgeLock, updateLastHeartbeat, updateBridgeLockField, readBridgeLockField, updateOwnedBridgeLockField, writeOwnedExitFields, writeRestartRequested, readAndClearRestartReason } from "./bridge-lock-transport.js";

const STALE_SECONDS = 120; // past the 30s orphan threshold in atomic-write.ts

describe("bridge.lock writes under an orphan temp file (#1632)", () => {
  let home: string;
  let lockPath: string;
  let tmpPath: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "abtars-lock-"));
    previousHome = process.env.ABTARS_HOME;
    process.env.ABTARS_HOME = home;
    lockPath = join(home, "bridge.lock");
    tmpPath = lockPath + ".tmp";
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.ABTARS_HOME;
    else process.env.ABTARS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function plantStaleOrphan(): void {
    writeFileSync(tmpPath, "half-written lock from a killed deploy");
    const past = new Date(Date.now() - STALE_SECONDS * 1000);
    utimesSync(tmpPath, past, past);
  }

  it("creates bridge.lock even when a stale orphan temp file is present", () => {
    plantStaleOrphan();

    initBridgeLock({ pid: process.pid, startedAt: Date.now(), version: "test", argv: [] });

    expect(existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(lock.pid).toBe(process.pid);
    expect(typeof lock.lastHeartbeat).toBe("number");
    expect(existsSync(tmpPath)).toBe(false);
  });

  it("keeps updating lastHeartbeat after an orphan — the L1 lifeline survives", () => {
    plantStaleOrphan();
    initBridgeLock({ pid: process.pid, startedAt: Date.now(), version: "test", argv: [] });

    const first = readBridgeLockField<number>("lastHeartbeat");
    expect(first).toBeTypeOf("number");

    // A second orphan mid-life must not stop the heartbeat either: this is the
    // path that silently died for a whole afternoon.
    plantStaleOrphan();
    updateLastHeartbeat();

    const second = readBridgeLockField<number>("lastHeartbeat");
    expect(second).toBeTypeOf("number");
    expect(second!).toBeGreaterThanOrEqual(first!);
    expect(existsSync(tmpPath)).toBe(false);
  });

  it("persists arbitrary field updates after an orphan", () => {
    initBridgeLock({ pid: 1, startedAt: Date.now(), version: "test", argv: [] });
    plantStaleOrphan();

    updateBridgeLockField("customNonGatedField", "value");

    expect(readBridgeLockField<string>("customNonGatedField")).toBe("value");
  });

  it("refuses gated fields on the generic path (#1711 R1) — only CLI/watchdog-owned keys pass", () => {
    initBridgeLock({ pid: 1, startedAt: Date.now(), version: "test", argv: [] });

    const before = readFileSync(lockPath, "utf-8");
    for (const key of [
      "lastHeartbeat",
      "lastExitCode",
      "lastExitAt",
      "heapUsedMB",
      "lastPromptAt",
      "startedAt",
      "acpPids",
      "sleepStatus",
      "restartReason",
    ]) {
      updateBridgeLockField(key, "forged");
      expect(readBridgeLockField(key)).not.toBe("forged");
    }
    expect(readFileSync(lockPath, "utf-8")).toBe(before);

    // CLI-owned field intentionally remains writable by a non-owner process.
    updateBridgeLockField("restartRequested", "restart");
    expect(readBridgeLockField<string>("restartRequested")).toBe("restart");
  });
});

describe("owner-scoped lock writes (#1711 R1)", () => {
  let home: string;
  let lockPath: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "abtars-owner-"));
    previousHome = process.env.ABTARS_HOME;
    process.env.ABTARS_HOME = home;
    lockPath = join(home, "bridge.lock");
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.ABTARS_HOME;
    else process.env.ABTARS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function plantLock(lock: Record<string, unknown>): void {
    writeFileSync(lockPath, JSON.stringify(lock));
  }

  function readLock(): Record<string, unknown> {
    return JSON.parse(readFileSync(lockPath, "utf-8"));
  }

  it("accepts the owner's heartbeat after initBridgeLock", () => {
    initBridgeLock({ pid: process.pid, startedAt: Date.now(), version: "test", argv: [] });
    const before = readBridgeLockField<number>("lastHeartbeat");

    expect(updateLastHeartbeat()).toBeUndefined(); // fire-and-forget cadence unchanged

    const after = readBridgeLockField<number>("lastHeartbeat");
    expect(after).toBeTypeOf("number");
    expect(after!).toBeGreaterThanOrEqual(before!);
  });

  it("rejects a non-owner forging lastHeartbeat (B3)", () => {
    plantLock({ pid: process.pid + 12345, instanceId: "some-other-bridge", lastHeartbeat: 111 });
    // This test process is NOT the lock owner (different pid).

    expect(updateOwnedBridgeLockField("lastHeartbeat", 999)).toBe(false);

    expect(readBridgeLockField<number>("lastHeartbeat")).toBe(111);
  });

  it("rejects a non-owner forging exit fields (B4)", () => {
    plantLock({ pid: process.pid + 999, instanceId: "other", lastExitCode: null });

    expect(writeOwnedExitFields(0, Date.now())).toBe(false);

    expect(readLock().lastExitCode).toBeNull();
    expect(readLock().lastExitAt).toBeUndefined();
  });

  it("rejects a write whose instanceId belongs to another bridge", () => {
    // Lock names this pid but carries a foreign instanceId — e.g. the PID was
    // recycled and a new bridge already re-initialized the lock.
    plantLock({ pid: process.pid, instanceId: "not-my-instance" });

    expect(updateOwnedBridgeLockField("sleepStatus", "sleeping")).toBe(false);

    expect(readBridgeLockField<string>("sleepStatus")).toBeNull();
  });

  it("accepts an owner write when instanceId is present but unparseable", () => {
    initBridgeLock({ pid: process.pid, startedAt: Date.now(), version: "test", argv: [] });
    const lock = readLock();
    lock.instanceId = "   ";
    plantLock(lock);

    expect(updateOwnedBridgeLockField("lastHeartbeat", 1234)).toBe(true);
    expect(readBridgeLockField<number>("lastHeartbeat")).toBe(1234);
  });

  it("does not let a non-owner clear restartReason", () => {
    plantLock({ pid: process.pid + 12345, instanceId: "other", restartReason: "bridge-owned reason" });

    expect(readAndClearRestartReason()).toBe("bridge-owned reason");
    expect(readBridgeLockField<string>("restartReason")).toBe("bridge-owned reason");
  });

  it("accepts the owner's write when the lock lost instanceId but still names this pid (B2 interaction)", () => {
    // Corrupt-in-one-field lock: parses, pid matches, instanceId missing.
    // validateBridgeLock treats this as corrupt (no validated owner), so the
    // liveness path may eventually contain the process — but the healthy
    // bridge MUST keep heartbeating through it. Rejecting here would freeze
    // lastHeartbeat and authorize that containment (requirements R1).
    plantLock({ pid: process.pid, watchdogPid: 4242, startedAt: 5 });
    // Establish real owner context through a full init, then strip instanceId.
    initBridgeLock({ pid: process.pid, startedAt: Date.now(), version: "test", argv: [] });
    const stripped = readLock();
    delete stripped.instanceId;
    plantLock(stripped);
    const before = readBridgeLockField<number>("lastHeartbeat") as number;

    expect(updateOwnedBridgeLockField("lastHeartbeat", before + 50)).toBe(true);

    expect(readBridgeLockField<number>("lastHeartbeat")).toBe(before + 50);
  });

  it("tolerates a fully corrupt lock without crashing or writing", () => {
    writeFileSync(lockPath, "{corrupt json");
    initBridgeLock({ pid: process.pid, startedAt: Date.now(), version: "test", argv: [] });
    // Overwrite with corrupt again post-init to exercise the read failure arm.
    writeFileSync(lockPath, "not json at all");

    expect(updateOwnedBridgeLockField("heapUsedMB", 42)).toBe(false);
    expect(updateOwnedBridgeLockField("acpPids", [1])).toBe(false);
    expect(writeOwnedExitFields(3, Date.now())).toBe(false);

    expect(readFileSync(lockPath, "utf-8")).toBe("not json at all");
  });

  it("still lets the CLI process write restartRequested from a non-owner pid", () => {
    // abtars restart publishes a supervisor command AND calls
    // writeRestartRequested from the CLI process — its pid intentionally
    // differs from the bridge's. A blanket gate would break `abtars restart`.
    // No scenario drives this write (restart.ts also signals via command), so
    // this focused test is the only guard (requirements R1 / tasks Task 2).
    plantLock({ pid: process.pid + 555, instanceId: "bridge-instance" });

    writeRestartRequested("restart");

    expect(typeof readBridgeLockField<string>("restartRequested")).toBe("string");
  });

  it("keeps acpPids owner-scoped while remaining readable by any process", () => {
    initBridgeLock({ pid: process.pid, startedAt: Date.now(), version: "test", argv: [] });

    updateOwnedBridgeLockField("acpPids", [101, 102]);

    expect(readBridgeLockField<number[]>("acpPids")).toEqual([101, 102]);
  });
});

describe("corrupt-lock forensic copy before repair (#1711 R3)", () => {
  let home: string;
  let lockPath: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "abtars-forensic-"));
    previousHome = process.env.ABTARS_HOME;
    process.env.ABTARS_HOME = home;
    lockPath = join(home, "bridge.lock");
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.ABTARS_HOME;
    else process.env.ABTARS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("preserves one timestamped copy of a corrupt lock during initBridgeLock repair", () => {
    const corrupt = '{"pid": 123, "instanceId": "trunc';
    writeFileSync(lockPath, corrupt);

    initBridgeLock({ pid: process.pid, startedAt: Date.now(), version: "test", argv: [] });

    // Lock was repaired with fresh boot state...
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).pid).toBe(process.pid);

    // ...and exactly one forensic copy preserves the original bytes.
    const copies = readdirSync(home).filter((f) => f.startsWith("bridge.lock.corrupt."));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(home, copies[0]!), "utf-8")).toBe(corrupt);
  });

  it("creates no forensic copy when the previous lock parsed fine", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 5, lastHeartbeat: 7 }));

    initBridgeLock({ pid: process.pid, startedAt: Date.now(), version: "test", argv: [] });

    expect(readdirSync(home).filter((f) => f.startsWith("bridge.lock.corrupt."))).toHaveLength(0);
  });
});
