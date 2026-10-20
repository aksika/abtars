/**
 * pi-session-retention.ts — #1932 R8 production retention wiring.
 *
 * One boot entry point over three disjoint mechanisms:
 *
 * - Row-driven sweep: ended coding sessions and terminal supervised runs.
 *   A file is removed only when the durable row proves it (expected ID +
 *   header match + containment), the file itself is aged out, and no live
 *   writer holds it.
 * - Binding sweep: SDK conversation bindings (Main/worker chats) carry no
 *   end signal, so their Pi files are the working store and are never pruned
 *   here — absence is handled by resume/recovery at open. Only dead weight
 *   goes: binding records with no Pi file older than retention.
 * - Quarantine sweep: quarantined files older than retention are removed
 *   (they were verified at quarantine time and carry the session ID).
 *
 * Standalone Pi files are invisible to all sweeps: neither a row nor a
 * binding claims them. Everything is best-effort and never throws:
 * a retention failure must not break boot or a turn. Incomplete removals
 * keep their records so a later sweep retries.
 */
import { lstatSync, rmSync, readdirSync, statSync, unlinkSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { logDebug, logWarn } from "../logger.js";
import { isPathWithinRoot } from "../workspace-paths.js";
import { listSdkBindings, deleteSdkBinding } from "../transport/pi-sdk-conversation.js";
import { validatePersistedSession } from "./config.js";
import type { PiCodingSessionRecord, PiCodingSessionStore } from "./pi-coding-session-store.js";
import type { PiRunStore } from "./pi-run-store.js";
import type { PiRunRecord } from "./types.js";

const TAG = "pi-session-retention";

/** Seven-day ended-session retention. */
export const ENDED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
  rpcRemoved: string[];
  rpcKept: string[];
  bindingsPruned: string[];
  quarantineRemoved: string[];
}

/**
 * Boot-time sweep entry point. Row-driven pruning for terminal RPC files,
 * dead-weight binding cleanup, and aged quarantine removal. Never throws.
 */
export function sweepPiSessionsAtBoot(args: {
  stateDir: string;
  sessionStorageRoot: string;
  codingStore: PiCodingSessionStore;
  runStore: PiRunStore;
  now?: number;
}): PiSessionSweepReport {
  const now = args.now ?? Date.now();
  const empty: PiSessionSweepReport = { rpcRemoved: [], rpcKept: [], bindingsPruned: [], quarantineRemoved: [] };
  try {
    let codingRows: PiCodingSessionRecord[] = [];
    try {
      codingRows = args.codingStore.listSessionFiles();
    } catch (err) {
      logWarn(TAG, `retention could not list coding sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
    const runRows: PiRunRecord[] = [];
    for (const status of TERMINAL_RUN_STATUSES) {
      try {
        runRows.push(...args.runStore.list({ status }));
      } catch (err) {
        logWarn(TAG, `retention could not list ${status} runs: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

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
    const bindingsPruned = sweepStaleBindings(args.stateDir, now);
    const quarantineRemoved = sweepQuarantineFiles(args.sessionStorageRoot, now);
    const pruned = [...rpc.removed, ...bindingsPruned, ...quarantineRemoved];
    if (pruned.length > 0) {
      logDebug(TAG, `retention pruned rpc=[${rpc.removed.join(",")}] bindings=[${bindingsPruned.join(",")}] quarantine=[${quarantineRemoved.join(",")}]`);
    }
    return {
      rpcRemoved: rpc.removed,
      rpcKept: rpc.kept,
      bindingsPruned,
      quarantineRemoved,
    };
  } catch (err) {
    logWarn(TAG, `retention sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    return empty;
  }
}

/**
 * Drop binding records whose Pi file is gone and whose record is older
 * than retention. Pi files of bound conversations are the working store
 * and are never removed here.
 */
export function sweepStaleBindings(stateDir: string, now: number): string[] {
  const pruned: string[] = [];
  let bindings: ReturnType<typeof listSdkBindings>;
  try {
    bindings = listSdkBindings(stateDir);
  } catch (err) {
    logWarn(TAG, `retention could not list bindings: ${err instanceof Error ? err.message : String(err)}`);
    return pruned;
  }
  for (const binding of bindings) {
    const file = binding.binding.sessionFile;
    if (file !== undefined) {
      try {
        if (lstatSync(file).isFile()) continue;
      } catch {
        // Gone — fall through to the age check.
      }
    }
    if (now - binding.binding.updatedAt < ENDED_RETENTION_MS) continue;
    try {
      if (deleteSdkBinding(stateDir, binding.sessionKey)) pruned.push(binding.sessionKey);
    } catch (err) {
      logWarn(TAG, `retention could not prune binding: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return pruned;
}

/**
 * Remove quarantined files older than retention. They were verified at
 * quarantine time; the name carries the session ID and the root bounds
 * the walk. Symlinks are never followed.
 */
export function sweepQuarantineFiles(sessionStorageRoot: string, now: number): string[] {
  const removed: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory — skip the subtree.
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isPathWithinRoot(sessionStorageRoot, path)) walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.includes(".quarantined-")) continue;
      let age: number | null = null;
      try {
        age = now - statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (age === null || age < ENDED_RETENTION_MS) continue;
      try {
        unlinkSync(path);
        removed.push(path);
      } catch {
        // A later sweep retries.
      }
    }
  };
  try {
    walk(sessionStorageRoot);
  } catch (err) {
    logWarn(TAG, `retention quarantine walk failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return removed;
}

/**
 * Explicit erasure of one coding session's owned files: the row's proven
 * transcript file plus aged quarantine siblings carrying the same session
 * ID. Returns the removed file list; empty means nothing was removed
 * (never an error by itself — the caller reports row state accordingly).
 */
export function eraseCodingSessionFiles(args: {
  sessionStorageRoot: string;
  piSessionId?: string;
  piSessionFile?: string;
}): string[] {
  const removed: string[] = [];
  if (args.piSessionFile && args.piSessionId && removeProvenSessionFile(args.sessionStorageRoot, args.piSessionId, args.piSessionFile)) {
    removed.push(args.piSessionFile);
  }
  if (args.piSessionId) {
    const dir = args.piSessionFile !== undefined ? dirnameOf(args.piSessionFile) : undefined;
    if (dir !== undefined) {
      for (const sibling of quarantineSiblings(dir, args.piSessionId)) {
        try {
          unlinkSync(sibling);
          removed.push(sibling);
        } catch {
          // Best effort; the transcript removal above already succeeded.
        }
      }
    }
  }
  return removed;
}

function dirnameOf(file: string): string | undefined {
  const index = file.lastIndexOf("/");
  return index > 0 ? file.slice(0, index) : undefined;
}

/** Quarantine siblings carrying the session ID, inside the owned directory. */
function quarantineSiblings(dir: string, sessionId: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const siblings: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    if (!entry.name.includes(sessionId) || !entry.name.includes(".quarantined-")) continue;
    siblings.push(join(dir, entry.name));
  }
  return siblings;
}
