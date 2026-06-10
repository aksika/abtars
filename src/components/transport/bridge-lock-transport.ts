/**
 * bridge.lock — single source of truth for bridge runtime state.
 * Fields: pid, startedAt, lastHeartbeat, lastPromptAt, version,
 *         sleepStatus, restartReason, restartRequested, forceSleep.
 */
import { logAndSwallow } from "../log-and-swallow.js";
import { readFileSync } from "node:fs";
import { atomicWriteSync } from "../atomic-write.js";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { localISO } from "../../utils/local-time.js";

export type SleepStatus = "awake" | "sleeping" | "hw_sleep";

/** Add an ACP child PID to bridge.lock tracking. */
export function trackAcpPid(pid: number): void {
  const pids = readBridgeLockField<number[]>("acpPids") ?? [];
  pids.push(pid);
  updateBridgeLockField("acpPids", pids);
}

/** Read and clear stale ACP PIDs from bridge.lock. */
export function readAndClearAcpPids(): number[] {
  const pids = readBridgeLockField<number[]>("acpPids") ?? [];
  if (pids.length) updateBridgeLockField("acpPids", []);
  return pids;
}

/** Read lastPromptAt from bridge.lock. Returns 0 if missing/unreadable. */
export function readLastPromptAt(): number {
  try {
    const lock = JSON.parse(readFileSync(join(abtarsHome(), "bridge.lock"), "utf-8"));
    return typeof lock.lastPromptAt === "number" ? lock.lastPromptAt : 0;
  } catch (err) { logAndSwallow("bridge_lock_transport", "readLastPromptAt", err); return 0; }
}

/** Update a single field in bridge.lock (read-merge-write). */
export function updateBridgeLockField(key: string, value: unknown): void {
  const p = join(abtarsHome(), "bridge.lock");
  try {
    const lock = JSON.parse(readFileSync(p, "utf-8"));
    lock[key] = value;
    atomicWriteSync(p, JSON.stringify(lock));
  } catch (err) { logAndSwallow("bridge_lock_transport", "op", err); }
}

/** Read a field from bridge.lock. Returns null if missing/unreadable. */
export function readBridgeLockField<T = unknown>(key: string): T | null {
  try {
    const lock = JSON.parse(readFileSync(join(abtarsHome(), "bridge.lock"), "utf-8"));
    return lock[key] ?? null;
  } catch (err) { logAndSwallow("bridge_lock_transport", "readBridgeLockField", err); return null; }
}

/** Write restart reason to bridge.lock. */
export function writeRestartReason(reason: string): void {
  updateBridgeLockField("restartReason", `${localISO()} ${reason}`);
}

/** Read and clear restart reason from bridge.lock. */
export function readAndClearRestartReason(): string | null {
  const reason = readBridgeLockField<string>("restartReason");
  if (reason) updateBridgeLockField("restartReason", null);
  return reason;
}

/** Write restart request to bridge.lock. */
export function writeRestartRequested(reason: string): void {
  updateBridgeLockField("restartRequested", `${localISO()} ${reason}`);
}

/** Read and clear restart request from bridge.lock. */
export function readAndClearRestartRequested(): string | null {
  const req = readBridgeLockField<string>("restartRequested");
  if (req) updateBridgeLockField("restartRequested", null);
  return req;
}

/** Update sleep status in bridge.lock. */
export function writeSleepStatus(status: SleepStatus): void {
  updateBridgeLockField("sleepStatus", status);
}

/** Append a restart timestamp to bridge.lock (capped at 10). Used by in-process watchdog circuit breaker. */
export function appendRestartTimestamp(): void {
  const ts = readBridgeLockField<number[]>("restartTimestamps") ?? [];
  ts.push(Date.now());
  if (ts.length > 10) ts.splice(0, ts.length - 10);
  updateBridgeLockField("restartTimestamps", ts);
}

/** Read recent restart timestamps from bridge.lock. */
export function readRestartTimestamps(): number[] {
  return readBridgeLockField<number[]>("restartTimestamps") ?? [];
}

/** Request a forced sleep cycle on the next heartbeat tick.
 *  See src/capabilities/sleep/index.ts spawnSleep() + src/components/daily-cycle.ts isDailyCycleDue().
 *  Pattern mirrors writeRestartRequested/readAndClearRestartRequested. */
export function writeForceSleep(reason: string): void {
  updateBridgeLockField("forceSleep", `${localISO()} ${reason}`);
}

/** Read and clear the force-sleep request from bridge.lock.
 *  Sole deleter: spawnSleep. isDailyCycleDue peeks via readBridgeLockField. */
export function readAndClearForceSleep(): string | null {
  const v = readBridgeLockField<string>("forceSleep");
  if (v) updateBridgeLockField("forceSleep", null);
  return v;
}

/** Initialize bridge.lock with full boot state. Single writer for initial creation. */
export function initBridgeLock(opts: { pid: number; startedAt: number; version: string; argv: string[] }): void {
  const p = join(abtarsHome(), "bridge.lock");
  try {
    atomicWriteSync(p, JSON.stringify({
      pid: opts.pid, startedAt: opts.startedAt, version: opts.version,
      sleepStatus: "awake", argv: opts.argv, lastHeartbeat: Date.now(),
    }));
  } catch (err) { logAndSwallow("bridge_lock_transport", "op", err); }
}

/** Update lastHeartbeat timestamp in bridge.lock (called every tick). */
export function updateLastHeartbeat(): void {
  updateBridgeLockField("lastHeartbeat", Date.now());
}
