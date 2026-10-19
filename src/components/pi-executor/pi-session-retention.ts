/**
 * pi-session-retention.ts — #1932 R8 production retention wiring.
 *
 * Two complementary sweeps, one boot entry point:
 *
 * - Adapter-registry sweep (`sweepPiRetention`): registered abtars-owned
 *   conversations (recovery successors today; SDK-managed sessions after
 *   cutover). A conversation counts as active when a live executor row
 *   still references its conversation ID, so recovery successors of live
 *   RPC sessions are never pruned regardless of age.
 * - Row-driven sweep: ended coding sessions and terminal supervised runs
 *   whose Pi files were never adapter-registered (all RPC launches today).
 *   A file is removed only when the durable row proves it (expected ID +
 *   header match + containment), the file itself is aged out, and no live
 *   writer holds it. Standalone Pi files are invisible to both sweeps:
 *   neither the registry nor an executor row claims them.
 *
 * Everything is best-effort and never throws: a retention failure must not
 * break boot or a turn. Incomplete removals keep their records so a later
 * sweep retries.
 */
import { lstatSync, rmSync, statSync } from "node:fs";
import { logDebug, logWarn } from "../logger.js";
import {
  ENDED_RETENTION_MS,
  erasePiConversation,
  sweepPiRetention,
} from "../pi-session/pi-session-adapter.js";
import { validatePersistedSession } from "./config.js";
import type { PiCodingSessionRecord, PiCodingSessionStore } from "./pi-coding-session-store.js";
import type { PiRunStore } from "./pi-run-store.js";
import type { PiRunRecord } from "./types.js";

const TAG = "pi-session-retention";

/** Terminal supervised generations never resume; interrupted ones may. */
const TERMINAL_RUN_STATUSES: ReadonlyArray<PiRunRecord["status"]> = ["completed", "failed", "cancelled"];

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Remove one proven session file. Proof (expected ID + header match +
 * containment + regular file) plus an explicit symlink rejection: a link
 * inside the root could otherwise resolve to a file outside it. Returns
 * whether the file is gone; never throws.
 */
export function removeProvenSessionFile(
  sessionStorageRoot: string,
  expectedSessionId: string | undefined,
  file: string | undefined,
): boolean {
  if (!expectedSessionId || !file) return false;
  const proof = validatePersistedSession({
    sessionStorageRoot,
    expectedSessionId,
    sessionFile: file,
  });
  if (!proof.ok) {
    logDebug(TAG, `retention keeps unproven file (${proof.capability}): ${proof.reason}`);
    return false;
  }
  try {
    // Lstat the un-resolved path: realpath above already contained the
    // target, but a link inside the root must never be followed for
    // deletion — remove only the file the row actually owns.
    if (lstatSync(file).isSymbolicLink()) {
      logWarn(TAG, "retention refuses to remove a symlinked session file");
      return false;
    }
    rmSync(proof.canonicalFile);
    return true;
  } catch {
    logWarn(TAG, "retention could not remove an owned session file");
    return false;
  }
}

function fileAgeMs(file: string, now: number): number | null {
  try {
    return now - statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

export interface RpcSessionFileRef {
  kind: "coding" | "supervised";
  sessionId: string;
  piSessionId?: string;
  piSessionFile?: string;
  observedPid?: number;
  /** True only for states that never resume (ended coding sessions,
   *  terminal supervised generations). */
  terminal: boolean;
}

export interface RpcSweepReport {
  removed: string[];
  kept: string[];
}

/**
 * Prune aged files of terminal RPC sessions. Keeps everything that is not
 * terminal, has no proven file, is younger than retention, or still has a
 * live writer. Pure over the given refs (filesystem reads only).
 */
export function sweepRpcSessionFiles(
  sessionStorageRoot: string,
  refs: readonly RpcSessionFileRef[],
  now: number,
): RpcSweepReport {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const ref of refs) {
    if (!ref.terminal || !ref.piSessionId || !ref.piSessionFile) {
      kept.push(ref.sessionId);
      continue;
    }
    if (ref.observedPid !== undefined && isProcessAlive(ref.observedPid)) {
      kept.push(ref.sessionId);
      continue;
    }
    const age = fileAgeMs(ref.piSessionFile, now);
    if (age === null || age < ENDED_RETENTION_MS) {
      kept.push(ref.sessionId);
      continue;
    }
    if (removeProvenSessionFile(sessionStorageRoot, ref.piSessionId, ref.piSessionFile)) {
      removed.push(ref.sessionId);
    } else {
      kept.push(ref.sessionId);
    }
  }
  return { removed, kept };
}

export interface PiSessionSweepReport {
  registryRemoved: string[];
  registryKept: string[];
  rpcRemoved: string[];
  rpcKept: string[];
}

/**
 * Boot-time sweep entry point. Registry sweep first (adapter-managed
 * conversations, with live executor rows as the activity fence), then the
 * row-driven sweep for unregistered RPC files. Never throws.
 */
export function sweepPiSessionsAtBoot(args: {
  sessionStorageRoot: string;
  codingStore: PiCodingSessionStore;
  runStore: PiRunStore;
  now?: number;
}): PiSessionSweepReport {
  const now = args.now ?? Date.now();
  const empty: PiSessionSweepReport = { registryRemoved: [], registryKept: [], rpcRemoved: [], rpcKept: [] };
  try {
    const liveIds = new Set<string>();
    let codingRows: PiCodingSessionRecord[] = [];
    try {
      codingRows = args.codingStore.listSessionFiles();
    } catch (err) {
      logWarn(TAG, `retention could not list coding sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const row of codingRows) {
      if (row.state !== "ended" && row.piSessionId) liveIds.add(row.piSessionId);
    }
    const runRows: PiRunRecord[] = [];
    for (const status of TERMINAL_RUN_STATUSES) {
      try {
        runRows.push(...args.runStore.list({ status }));
      } catch (err) {
        logWarn(TAG, `retention could not list ${status} runs: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    let liveRuns: PiRunRecord[] = [];
    try {
      liveRuns = args.runStore.list().filter((run) => !(TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status));
    } catch (err) {
      logWarn(TAG, `retention could not list live runs: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const run of liveRuns) {
      if (run.piSessionId) liveIds.add(run.piSessionId);
    }

    const registry = sweepPiRetention(args.sessionStorageRoot, now, (id) => liveIds.has(id));

    const refs: RpcSessionFileRef[] = [
      ...codingRows
        .filter((row) => row.state === "ended")
        .map((row): RpcSessionFileRef => ({
          kind: "coding",
          sessionId: row.sessionId,
          piSessionId: row.piSessionId,
          piSessionFile: row.piSessionFile,
          observedPid: row.observedPid,
          terminal: true,
        })),
      ...runRows.map((run): RpcSessionFileRef => ({
        kind: "supervised",
        sessionId: run.id,
        piSessionId: run.piSessionId,
        piSessionFile: run.piSessionFile,
        observedPid: run.observedPid,
        terminal: true,
      })),
    ];
    const rpc = sweepRpcSessionFiles(args.sessionStorageRoot, refs, now);
    if (registry.removed.length > 0 || rpc.removed.length > 0) {
      logDebug(TAG, `retention pruned registry=[${registry.removed.join(",")}] rpc=[${rpc.removed.join(",")}]`);
    }
    return {
      registryRemoved: registry.removed,
      registryKept: registry.kept,
      rpcRemoved: rpc.removed,
      rpcKept: rpc.kept,
    };
  } catch (err) {
    logWarn(TAG, `retention sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    return empty;
  }
}

/**
 * Explicit erasure of one coding session's owned files. The adapter sweep
 * covers registered conversation IDs (recovery successors); the row's own
 * proven file covers the common unregistered RPC case. Returns the removed
 * file list; empty means nothing was removed (never an error by itself —
 * the caller reports row state accordingly).
 */
export function eraseCodingSessionFiles(args: {
  sessionStorageRoot: string;
  piSessionId?: string;
  piSessionFile?: string;
}): string[] {
  const removed: string[] = [];
  if (args.piSessionId) {
    try {
      const report = erasePiConversation(args.sessionStorageRoot, args.piSessionId);
      removed.push(...report.removedFiles);
    } catch (err) {
      logWarn(TAG, `explicit erasure could not sweep registry files: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (args.piSessionFile && !removed.includes(args.piSessionFile)) {
    if (removeProvenSessionFile(args.sessionStorageRoot, args.piSessionId, args.piSessionFile)) {
      removed.push(args.piSessionFile);
    }
  }
  return removed;
}
