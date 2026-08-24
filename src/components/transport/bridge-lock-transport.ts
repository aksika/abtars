/**
 * bridge.lock — single source of truth for bridge runtime state.
 * Fields: pid, startedAt, lastHeartbeat, lastPromptAt, version,
 *         sleepStatus, restartReason, restartRequested.
 */
import { logAndSwallow } from "../log-and-swallow.js";
import { logWarn } from "../logger.js";
import { readFileSync, writeFileSync } from "node:fs";
import { atomicWriteSync } from "../atomic-write.js";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { localISO } from "../../utils/local-time.js";
import { randomUUID } from "node:crypto";
import { processStartIdentity } from "../../supervisor/identity.js";

export type SleepStatus = "awake" | "sleeping";

// ── Owner-scoped writes (#1711 R1) ────────────────────────────────────────
// Fields describing the bridge PROCESS ITSELF (lastHeartbeat, exit fields,
// memory/prompt markers, startedAt, acpPids, sleepStatus, restartReason) are
// writable only by the process the lock names. A non-owner must never be able
// to forge liveness evidence (B3) or exit records (B4). The generic
// updateBridgeLockField stays available for fields that are intentionally NOT
// bridge-owned: restartRequested (written by the abtars restart CLI process,
// whose PID differs from the bridge), watchdogPid/watchdogStartIdentity
// (watchdog), and whole-lock creation in initBridgeLock.

interface LockOwnerContext { readonly pid: number; readonly instanceId: string }

let ownerContext: LockOwnerContext | null = null;

function readableLockInstanceId(lock: Record<string, unknown>): string | null {
  const instanceId = lock.instanceId;
  return typeof instanceId === "string" && instanceId.trim().length > 0 ? instanceId : null;
}

/**
 * Read-merge-write one BRIDGE-OWNED lock field behind the ownership gate.
 *
 * Gate (#1711 R1):
 *   lock.pid !== process.pid                          -> reject (hard gate)
 *   lock.instanceId present and !== local instanceId  -> reject
 *   lock.instanceId absent/unparseable                -> accept — PIDs are unique
 *     among live processes, so lock.pid naming this process already proves the
 *     lock names us. Rejecting here too would freeze the healthy bridge's own
 *     heartbeat on a partially corrupted lock and let the liveness path contain
 *     a serving process (requirements R1).
 *
 * Rejection is warn-only and never retries: the watchdog owns recovery.
 */
export function updateOwnedBridgeLockField(key: string, value: unknown): boolean {
  const p = join(abtarsHome(), "bridge.lock");
  try {
    const lock = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    if (lock.pid !== process.pid) {
      logWarn("bridge_lock_transport", `owner-scoped write rejected (${key}): lock pid ${String(lock.pid)} != ${process.pid}`);
      return false;
    }
    const lockInstanceId = readableLockInstanceId(lock);
    if (lockInstanceId !== null && (ownerContext === null || lockInstanceId !== ownerContext.instanceId)) {
      logWarn("bridge_lock_transport", `owner-scoped write rejected (${key}): lock instanceId is not this bridge`);
      return false;
    }
    lock[key] = value;
    atomicWriteSync(p, JSON.stringify(lock));
    return true;
  } catch (err) {
    // Missing/corrupt/unwritable lock: tolerate without crashing the bridge or
    // retrying in a loop (#1632 semantics preserved).
    logAndSwallow("bridge_lock_transport", `updateOwnedBridgeLockField(${key}) on ${p}`, err);
    return false;
  }
}

/** Bridge-owned exit record written by the process exit handler in main.ts. */
export function writeOwnedExitFields(lastExitCode: number, lastExitAt: number): boolean {
  const p = join(abtarsHome(), "bridge.lock");
  try {
    const lock = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    if (lock.pid !== process.pid) {
      logWarn("bridge_lock_transport", `exit-field write rejected: lock pid ${String(lock.pid)} != ${process.pid}`);
      return false;
    }
    const lockInstanceId = readableLockInstanceId(lock);
    if (lockInstanceId !== null && (ownerContext === null || lockInstanceId !== ownerContext.instanceId)) {
      logWarn("bridge_lock_transport", "exit-field write rejected: lock instanceId is not this bridge");
      return false;
    }
    lock.lastExitCode = lastExitCode;
    lock.lastExitAt = lastExitAt;
    atomicWriteSync(p, JSON.stringify(lock));
    return true;
  } catch (err) {
    logAndSwallow("bridge_lock_transport", `writeOwnedExitFields on ${p}`, err);
    return false;
  }
}

/** Add an ACP child PID to bridge.lock tracking. */
export function trackAcpPid(pid: number): void {
  const pids = readBridgeLockField<number[]>("acpPids") ?? [];
  pids.push(pid);
  updateOwnedBridgeLockField("acpPids", pids);
}

/** Read and clear stale ACP PIDs from bridge.lock. */
export function readAndClearAcpPids(): number[] {
  const pids = readBridgeLockField<number[]>("acpPids") ?? [];
  if (pids.length) updateOwnedBridgeLockField("acpPids", []);
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
  } catch (err) { logAndSwallow("bridge_lock_transport", `updateBridgeLockField(${key}) on ${p}`, err); }
}

/** Read a field from bridge.lock. Returns null if missing/unreadable. */
export function readBridgeLockField<T = unknown>(key: string): T | null {
  try {
    const lock = JSON.parse(readFileSync(join(abtarsHome(), "bridge.lock"), "utf-8"));
    return lock[key] ?? null;
  } catch (err) { logAndSwallow("bridge_lock_transport", "readBridgeLockField", err); return null; }
}

/** Write restart reason to bridge.lock (bridge-owned, owner-scoped per #1711 R1). */
export function writeRestartReason(reason: string): void {
  updateOwnedBridgeLockField("restartReason", `${localISO()} ${reason}`);
}

/** Read and clear restart reason from bridge.lock. */
export function readAndClearRestartReason(): string | null {
  const reason = readBridgeLockField<string>("restartReason");
  if (reason) updateOwnedBridgeLockField("restartReason", null);
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

/** Update sleep status in bridge.lock (bridge-owned, owner-scoped per #1711 R1). */
export function writeSleepStatus(status: SleepStatus): void {
  updateOwnedBridgeLockField("sleepStatus", status);
}

/** Initialize bridge.lock with full boot state. Single writer for initial creation. */
export interface PrevBridgeState { pid: number | null; lastHeartbeat: number | null }

export function initBridgeLock(opts: { pid: number; startedAt: number; version: string; argv: string[]; startReason?: string }): PrevBridgeState {
  const p = join(abtarsHome(), "bridge.lock");
  let prev: PrevBridgeState = { pid: null, lastHeartbeat: null };
  try {
    // Read existing state (may have watchdogPid from watchdog, or stale pid from previous bridge)
    let existing: Record<string, unknown> = {};
    let rawText: string | null = null;
    try { rawText = readFileSync(p, "utf-8"); } catch { /* missing — cold boot */ }
    if (rawText !== null) {
      try {
        existing = JSON.parse(rawText);
      } catch {
        // #1711 R3: preserve ONE timestamped forensic copy before repair. The
        // copy proves nothing about liveness — the zero-process enumeration
        // gate owns spawn authorization; this only keeps evidence readable.
        try {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          writeFileSync(join(abtarsHome(), `bridge.lock.corrupt.${stamp}`), rawText);
        } catch { /* best effort */ }
      }
    }
    const prevPid = typeof existing.pid === "number" ? existing.pid : null;
    prev = { pid: prevPid, lastHeartbeat: typeof existing.lastHeartbeat === "number" ? existing.lastHeartbeat : null };
    // Classify boot type from previous heartbeat gap. The value reflects the
    // gap since the previous process's last heartbeat, not any wake classification.
    let bootType = "cold";
    if (prev.lastHeartbeat) {
      const gapS = (Date.now() - prev.lastHeartbeat) / 1000;
      if (gapS < 300) bootType = "quick-restart";
      else if (gapS <= 7200) bootType = "short-outage";
      else bootType = "long-outage";
    }
    // Merge: preserve watchdogPid from watchdog or env var
    const wdPid = Number(process.env.ABTARS_WATCHDOG_PID) || existing.watchdogPid || null;
    const wdStartIdentity = typeof existing.watchdogStartIdentity === "string"
      ? existing.watchdogStartIdentity
      : (typeof wdPid === "number" && wdPid > 0 ? processStartIdentity(wdPid) : null);
    // A bridge instance ID belongs to this process, not to the lock file. Never
    // carry the previous bridge's ID across a respawn.
    const instanceId = randomUUID();
    // #1711 R1: record the process-local owner context BEFORE first write so
    // every later owner-scoped write can compare against the identity this
    // bridge published.
    ownerContext = { pid: opts.pid, instanceId };
    atomicWriteSync(p, JSON.stringify({
      pid: opts.pid, watchdogPid: wdPid, watchdogStartIdentity: wdStartIdentity,
      startedAt: opts.startedAt, version: opts.version,
      instanceId, startIdentity: processStartIdentity(opts.pid),
      sleepStatus: "awake", argv: opts.argv, lastHeartbeat: Date.now(),
      startReason: opts.startReason ?? "unknown", bootType,
    }));
  } catch (err) {
    // #1632: a bridge running without a lock has no L1→L3 watchdog lifeline —
    // the watchdog reads bridge.lock to decide whether this process is alive.
    // This failure caused a full-afternoon outage while logging nothing
    // identifiable, so it is reported at error level, never as a trace line.
    logAndSwallow("bridge_lock_transport", `initBridgeLock on ${p}`, err, "error");
  }
  return prev;
}

/** Update lastHeartbeat timestamp in bridge.lock (called every tick).
 *  Owner-scoped per #1711 R1: a non-owner must not forge liveness evidence. */
export function updateLastHeartbeat(): void {
  updateOwnedBridgeLockField("lastHeartbeat", Date.now());
}
