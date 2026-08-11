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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initBridgeLock, updateLastHeartbeat, updateBridgeLockField, readBridgeLockField } from "./bridge-lock-transport.js";

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

    initBridgeLock({ pid: 31071, startedAt: Date.now(), version: "test", argv: [] });

    expect(existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(lock.pid).toBe(31071);
    expect(typeof lock.lastHeartbeat).toBe("number");
    expect(existsSync(tmpPath)).toBe(false);
  });

  it("keeps updating lastHeartbeat after an orphan — the L1 lifeline survives", () => {
    plantStaleOrphan();
    initBridgeLock({ pid: 31071, startedAt: Date.now(), version: "test", argv: [] });

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

    updateBridgeLockField("sleepStatus", "sleeping");

    expect(readBridgeLockField<string>("sleepStatus")).toBe("sleeping");
  });
});
