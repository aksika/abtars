import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, mkdirSync, unlinkSync, existsSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { processStartIdentity, isPidAlive } from "./identity.js";

export type DesiredState = "running" | "stopped";

export interface SupervisorState {
  readonly schemaVersion: 1;
  desiredState: DesiredState;
  nextCommandSeq: number;
  pendingCommand: PendingCommand | null;
  acknowledgedCommandSeq: number;
  restartCount: number;
  backoffAttempt: number;
  recentDeaths: number[];
  lastDeathAt: string | null;
}

export interface PendingCommand {
  readonly seq: number;
  readonly type: string;
  readonly reason: string;
  readonly createdAt: string;
}

export type CommandResult = "created" | "coalesced" | "busy";

export type StateReadResult =
  | { readonly ok: true; readonly state: SupervisorState }
  | { readonly ok: false; readonly reason: "missing" | "corrupt" | "locked" | "invalid-schema" };

export type MigrationResult =
  | { readonly ok: true; readonly migrated: boolean }
  | { readonly ok: false; readonly error: string };

export interface LockOwner {
  readonly token: string;
  readonly pid: number;
  readonly startIdentity: string;
  readonly host: string;
  readonly operation: string;
  readonly createdAt: string;
}

export interface DeathObservation {
  readonly at: number;
  readonly reason: string;
}

const STATE_FILE = "supervisor.state";
const LOCK_DIR = ".supervisor.lock";

function defaultState(): SupervisorState {
  return {
    schemaVersion: 1,
    desiredState: "running",
    nextCommandSeq: 1,
    pendingCommand: null,
    acknowledgedCommandSeq: 0,
    restartCount: 0,
    backoffAttempt: 0,
    recentDeaths: [],
    lastDeathAt: null,
  };
}

function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function readTextSafe(path: string): string | null {
  try { return readFileSync(path, "utf-8"); } catch { return null; }
}

function writeAtomic(target: string, data: string): void {
  const tmp = target + ".tmp." + randomUUID().slice(0, 8);
  writeFileSync(tmp, data, "utf-8");
  const fd = openSync(tmp, "r");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, target);
}

export function readSupervisorState(home: string): StateReadResult {
  const path = join(home, STATE_FILE);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, reason: (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "corrupt" };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "corrupt" };
  }
  const pending = raw.pendingCommand;
  const nextCommandSeq = raw.nextCommandSeq;
  const acknowledgedCommandSeq = raw.acknowledgedCommandSeq;
  const restartCount = raw.restartCount;
  const backoffAttempt = raw.backoffAttempt;
  const pendingValid = pending === null || (
    typeof pending === "object" && pending !== null &&
    Number.isInteger((pending as Record<string, unknown>).seq) &&
    typeof (pending as Record<string, unknown>).type === "string" &&
    typeof (pending as Record<string, unknown>).reason === "string" &&
    typeof (pending as Record<string, unknown>).createdAt === "string"
  );
  if (
    raw.schemaVersion !== 1 ||
    (raw.desiredState !== "running" && raw.desiredState !== "stopped") ||
    typeof nextCommandSeq !== "number" || !Number.isInteger(nextCommandSeq) || nextCommandSeq < 1 ||
    !pendingValid ||
    typeof acknowledgedCommandSeq !== "number" || !Number.isInteger(acknowledgedCommandSeq) || acknowledgedCommandSeq < 0 ||
    typeof restartCount !== "number" || !Number.isInteger(restartCount) || restartCount < 0 ||
    typeof backoffAttempt !== "number" || !Number.isInteger(backoffAttempt) || backoffAttempt < 0 || backoffAttempt > 5 ||
    !Array.isArray(raw.recentDeaths) || raw.recentDeaths.some((t) => typeof t !== "number" || !Number.isFinite(t)) ||
    !(raw.lastDeathAt === null || typeof raw.lastDeathAt === "string")
  ) {
    return { ok: false, reason: "invalid-schema" };
  }
  return { ok: true, state: raw as unknown as SupervisorState };
}

export interface LockAcquireResult {
  readonly ok: true;
  readonly release: () => void;
}

export function acquireStateLock(home: string, operation: string, timeoutMs: number = 5000): LockAcquireResult | never {
  const lockPath = join(home, LOCK_DIR);
  const deadline = Date.now() + timeoutMs;
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    startIdentity: processStartIdentity(process.pid),
    host: hostname(),
    operation,
    createdAt: new Date().toISOString(),
  };

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath, { recursive: false });
      writeAtomic(join(lockPath, "owner.json"), JSON.stringify(owner));
      return {
        ok: true,
        release: () => releaseStateLock(lockPath, owner.token),
      };
    } catch {
      const existing = readJsonSafe<LockOwner>(join(lockPath, "owner.json"));
      if (existing) {
        const alive = isPidAlive(existing.pid);
        const startOk = processStartIdentity(existing.pid) === existing.startIdentity;
        if (!alive || !startOk) {
          const tombstone = lockPath + ".stale." + randomUUID().slice(0, 8);
          try {
            renameSync(lockPath, tombstone);
            rmSync(tombstone, { recursive: true, force: true });
            continue;
          } catch {
            // Another contender renamed it — retry
          }
        }
      } else {
        // A process can die after mkdir and before publishing owner.json. Do
        // not leave that empty lease blocking every future state operation.
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 1000) {
            const tombstone = lockPath + ".stale." + randomUUID().slice(0, 8);
            try {
              renameSync(lockPath, tombstone);
              rmSync(tombstone, { recursive: true, force: true });
              continue;
            } catch { /* another contender won */ }
          }
        } catch { /* lock disappeared */ }
      }
      sleep(50);
    }
  }

  throw new Error(`Failed to acquire supervisor lock for ${operation} within ${timeoutMs}ms`);
}

function releaseStateLock(lockPath: string, token: string): void {
  const owner = readJsonSafe<LockOwner>(join(lockPath, "owner.json"));
  if (owner && owner.token === token) {
    const releasedPath = lockPath + ".released." + randomUUID().slice(0, 8);
    try {
      // Remove the whole lease atomically; never expose an empty canonical
      // lock directory if this process dies during cleanup.
      renameSync(lockPath, releasedPath);
    } catch {
      return;
    }
    rmSync(releasedPath, { recursive: true, force: true });
  }
}

function sleep(ms: number): void {
  try {
    const buf = new SharedArrayBuffer(4);
    const view = new Int32Array(buf);
    Atomics.wait(view, 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      /* busy-wait fallback */
    }
  }
}

function withStateLock<T>(home: string, operation: string, fn: (state: SupervisorState) => T): T {
  const lock = acquireStateLock(home, operation);
  try {
    const read = readSupervisorState(home);
    if (!read.ok && read.reason !== "missing") {
      throw new Error(`Cannot mutate ${operation}: supervisor.state is ${read.reason}`);
    }
    const state = read.ok ? read.state : defaultState();
    const result = fn(state);
    writeAtomic(join(home, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
    return result;
  } finally {
    lock.release();
  }
}

export function setDesiredState(home: string, desired: DesiredState): SupervisorState {
  return withStateLock(home, `setDesiredState:${desired}`, (state) => {
    state.desiredState = desired;
    if (desired === "stopped") {
      state.pendingCommand = null;
    } else if (state.pendingCommand?.type === "stop") {
      // Starting cancels a stop that was published but not yet applied.
      state.pendingCommand = null;
    }
    return state;
  });
}

export function publishCommand(home: string, type: string, reason: string): { result: CommandResult; state: SupervisorState } {
  return withStateLock(home, `publishCommand:${type}`, (state) => {
    // Stop is represented by durable desiredState, not a command that can get
    // stranded ahead of a future start.
    if (type === "stop") {
      state.desiredState = "stopped";
      state.pendingCommand = null;
      return { result: "created" as CommandResult, state };
    }
    if (state.pendingCommand) {
      if (state.pendingCommand.type === type && state.pendingCommand.reason === reason) {
        return { result: "coalesced" as CommandResult, state };
      }
      return { result: "busy" as CommandResult, state };
    }
    const seq = state.nextCommandSeq;
    state.nextCommandSeq = seq + 1;
    state.pendingCommand = {
      seq,
      type,
      reason,
      createdAt: new Date().toISOString(),
    };
    if (type === "stop") {
      state.desiredState = "stopped";
    }
    return { result: "created" as CommandResult, state };
  });
}

export function claimPendingCommand(home: string): PendingCommand | null {
  return withStateLock(home, "claimPendingCommand", (state) => {
    return state.pendingCommand ? { ...state.pendingCommand } : null;
  });
}

export function ackCommand(home: string, seq: number): boolean {
  return withStateLock(home, "ackCommand", (state) => {
    if (state.pendingCommand && state.pendingCommand.seq === seq) {
      state.pendingCommand = null;
      state.acknowledgedCommandSeq = seq;
      return true;
    }
    return false;
  });
}

export function recordBridgeDeath(home: string, observation: DeathObservation): SupervisorState {
  return withStateLock(home, "recordBridgeDeath", (state) => {
    state.restartCount += 1;
    state.lastDeathAt = new Date(observation.at).toISOString();
    state.recentDeaths.push(observation.at);
    if (state.recentDeaths.length > 10) {
      state.recentDeaths = state.recentDeaths.slice(-10);
    }
    state.backoffAttempt = Math.min(state.backoffAttempt + 1, 5);
    return state;
  });
}

export function recordHealthyInterval(home: string, now: number): SupervisorState {
  return withStateLock(home, "recordHealthyInterval", (state) => {
    const cutoff = now - 5 * 60 * 1000;
    state.recentDeaths = state.recentDeaths.filter((t) => t > cutoff);
    if (state.recentDeaths.length === 0) {
      state.backoffAttempt = 0;
    }
    const tenMinCutoff = now - 10 * 60 * 1000;
    const recentTen = state.recentDeaths.filter((t) => t > tenMinCutoff);
    if (recentTen.length === 0) {
      state.restartCount = 0;
    }
    return state;
  });
}

export function resetRestartCount(home: string, reason: string): SupervisorState {
  return withStateLock(home, `resetRestartCount:${reason}`, (state) => {
    state.restartCount = 0;
    state.backoffAttempt = 0;
    state.recentDeaths = [];
    state.lastDeathAt = null;
    return state;
  });
}

export function getBackoffDelayMs(state: SupervisorState): number {
  const delays = [0, 2000, 5000, 15000, 30000, 60000];
  const idx = Math.min(state.backoffAttempt, delays.length - 1);
  return delays[idx]!;
}

export function migrateSupervisorState(home: string): MigrationResult {
  const existing = readSupervisorState(home);
  if (existing.ok) {
    return { ok: true, migrated: false };
  }

  const lock = acquireStateLock(home, "migrate");
  try {
    const recheck = readSupervisorState(home);
    if (recheck.ok) {
      return { ok: true, migrated: false };
    }

    let desiredState: DesiredState = "running";
    const stoppedFile = join(home, ".stopped");
    if (existsSync(stoppedFile)) {
      desiredState = "stopped";
    } else {
      const startReasonPath = join(home, ".start-reason");
      const rawReason = readTextSafe(startReasonPath)?.trim();
      const sr = rawReason?.startsWith('"') ? readJsonSafe<string>(startReasonPath) : rawReason;
      if (sr === "stopped") {
        desiredState = "stopped";
      }
    }

    const deployStatePath = join(home, "deploy.state");
    const deployState = readJsonSafe<Record<string, unknown>>(deployStatePath);
    let restartCount = 0;
    let recentDeaths: number[] = [];
    let lastDeathAt: string | null = null;
    if (deployState) {
      restartCount = (deployState.restartCount as number) ?? 0;
      const dw = deployState.deathWindow as number[] | undefined;
      if (Array.isArray(dw)) {
        recentDeaths = dw;
      }
      lastDeathAt = (deployState.lastDeath as string) ?? null;
    }

    const state: SupervisorState = {
      schemaVersion: 1,
      desiredState,
      nextCommandSeq: 1,
      pendingCommand: null,
      acknowledgedCommandSeq: 0,
      restartCount,
      backoffAttempt: 0,
      recentDeaths,
      lastDeathAt,
    };

    writeAtomic(join(home, STATE_FILE), JSON.stringify(state, null, 2) + "\n");

    try { unlinkSync(stoppedFile); } catch { /* ok */ }
    try { unlinkSync(join(home, ".start-reason")); } catch { /* ok */ }
    if (deployState) {
      delete deployState.restartCount;
      delete deployState.deathWindow;
      delete deployState.lastDeath;
      writeAtomic(deployStatePath, JSON.stringify(deployState, null, 2) + "\n");
    }

    return { ok: true, migrated: true };
  } finally {
    lock.release();
  }
}

export function stateFilePath(home: string): string {
  return join(home, STATE_FILE);
}
