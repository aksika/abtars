/**
 * Shared scenario helpers (#1712 Phase 0). Scenario-specific behavior stays in
 * the scenario files; only genuinely reused observation goes here.
 */
import type { WorldApi } from "../contracts.ts";

export interface DeathEvent {
  readonly timestamp: string;
  readonly reason: string;
  readonly pid: string;
}

/**
 * Parse "Bridge died: <reason> (PID=<n>)" events from watchdog log lines.
 * Shared by A17/A22 (event reconstruction) and B9 (repetition throttling).
 * Anchored on stable markers, never full message wording.
 */
export function parseDeathEvents(logLines: readonly string[]): DeathEvent[] {
  const events: DeathEvent[] = [];
  for (const line of logLines) {
    const m = line.match(/^(\S+) Bridge died: (.+) \(PID=(\d+)\)$/);
    if (!m) continue;
    if (m[1] === undefined || m[2] === undefined || m[3] === undefined) continue;
    events.push({ timestamp: m[1], reason: m[2], pid: m[3] });
  }
  return events;
}

const exitSeqCounters = new WeakMap<object, number>();

function nextExitSeq(world: WorldApi): number {
  const next = (exitSeqCounters.get(world) ?? 0) + 1;
  exitSeqCounters.set(world, next);
  return next;
}

export interface LiveExitCommand {
  code: number;
  delayMs?: number;
  staleReport?: boolean;
}

/**
 * Publish a sequenced live-exit command. The seq guarantees a freshly
 * respawned bridge never executes a stale predecessor command.
 */
export function commandLiveExit(w: WorldApi, home: string, cmd: LiveExitCommand | null): void {
  w.setControl(home, {
    live: {
      heartbeatEnabled: true,
      ignoreTerm: false,
      exit: cmd === null ? null : { ...cmd, seq: nextExitSeq(w) },
    },
  });
}

/** A bridge.lock that a fully-initialized owner would have produced. */
export function lockLooksOwned(lock: Record<string, unknown> | null): boolean {
  if (!lock) return false;
  return (
    typeof lock.pid === "number" && lock.pid > 0 &&
    typeof lock.instanceId === "string" && lock.instanceId.length > 0 &&
    typeof lock.startIdentity === "string" && lock.startIdentity.length > 0 &&
    typeof lock.startedAt === "number"
  );
}

export async function waitForOwnedBridge(world: WorldApi, home: string, deadlineMs: number): Promise<Record<string, unknown>> {
  await world.until("owned bridge.lock present", deadlineMs, () => {
    const lock = world.lock(home);
    if (lock === null || !lockLooksOwned(lock)) return false;
    return world.procSnapshot(Number(lock.pid)) !== null;
  });
  const lock = world.lock(home);
  if (lock === null || !lockLooksOwned(lock)) {
    throw new Error(`unreachable: predicate verified lock shape (got ${JSON.stringify(lock)})`);
  }
  return lock;
}

export function bridgeAliveWithIdentity(world: WorldApi, home: string, expectedPid: number): boolean {
  if (!world.registry.isAlive(expectedPid) && world.procSnapshot(expectedPid) === null) return false;
  const snap = world.procSnapshot(expectedPid);
  if (!snap) return false;
  if (snap.state === "Z") return false;
  // The process must still be the bridge this home spawned.
  if (snap.cmdline === null || !snap.cmdline.includes("abtars.js")) return false;
  const cwd = world.processCwd(expectedPid);
  if (cwd !== null && cwd !== home) return false;
  return true;
}

/** Sample a predicate continuously for `windowMs`, returning every result. */
export async function sampleDuring(w: WorldApi, windowMs: number, sample: () => boolean): Promise<boolean[]> {
  const results: boolean[] = [];
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    results.push(sample());
    await w.sleep(120);
  }
  return results;
}

/**
 * Corrupt lock ownership the way the v4 draft defines it: valid JSON with
 * `instanceId` (and `startIdentity`) removed, so `validateBridgeLock`
 * classifies `corrupt`. The fixture is frozen (SIGSTOP) around the strip so
 * no in-flight heartbeat read-merge-write can restore the pre-strip snapshot,
 * then resumed. With `keepHeartbeatFrozen` (B11) the fixture is stale-shaped
 * so `lastHeartbeat` stays readable and frozen afterwards.
 */
export async function stripLockOwnership(
  w: WorldApi,
  home: string,
  fixturePid: number,
): Promise<void> {
  w.signalBridgeProcess(home, fixturePid, "SIGSTOP");
  await w.sleep(250); // let any in-flight beat land before we mutate
  const lock = w.lock(home);
  if (!lock) throw new Error(`stripLockOwnership: no lock at ${home}`);
  const stripped = { ...lock };
  delete stripped.instanceId;
  delete stripped.startIdentity;
  w.writeLock(home, stripped);
  w.signalBridgeProcess(home, fixturePid, "SIGCONT");
}

/**
 * Drive one crash cycle: command the LIVE bridge to self-exit with `code`
 * after `delayMs`, then wait for a validated replacement.
 */
export async function crashCycle(w: WorldApi, home: string, code: number, delayMs = 120): Promise<number> {
  // Never capture a stale pid: wait until whatever the lock records is alive.
  await w.expectEventually(15000, "current bridge alive before crash cycle", () => {
    const l = w.lock(home);
    return !!l && bridgeAliveWithIdentity(w, home, Number(l.pid));
  });
  const current = Number(w.lock(home)?.pid);
  w.expect(Number.isFinite(current) && current > 0, "crashCycle requires a running bridge");
  commandLiveExit(w, home, { code, delayMs });
  let replacement = -1;
  await w.expectEventually(35000, `bridge ${current} self-exits(code=${code}) and is replaced`, () => {
    const l = w.lock(home);
    if (!l) return false;
    const pid = Number(l.pid);
    if (pid === current || !bridgeAliveWithIdentity(w, home, pid)) return false;
    replacement = pid;
    return true;
  });
  return replacement;
}
