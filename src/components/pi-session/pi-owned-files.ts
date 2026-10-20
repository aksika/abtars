/**
 * pi-owned-files.ts — #1932: minimal owned-session-file helpers.
 *
 * Exact-ID discovery (header match within the authorized partition),
 * ambiguity detection, quarantine, and the archive seed writer. No
 * registry, no ownership table: the caller-held binding (sessionKey →
 * conversation ID) plus partition directories are the ownership record.
 * Standalone Pi files are invisible here — nothing claims them.
 */
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logWarn } from "../logger.js";
import { isPathWithinRoot } from "../workspace-paths.js";
import {
  isValidPiConversationId,
  verifyPiConversationFile,
} from "./pi-conversation-identity.js";

const TAG = "pi-owned-files";
const HEADER_READ_MAX_BYTES = 64 * 1024;

/** Bounded header-ID read: first line only, never the whole transcript. */
export function readPiSessionHeaderId(canonicalFile: string): string | null {
  let fd: number;
  try {
    fd = openSync(canonicalFile, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(HEADER_READ_MAX_BYTES);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    const data = bytesRead < buf.length ? buf.subarray(0, bytesRead) : buf;
    const newline = data.indexOf(0x0a);
    if (newline === -1) return null;
    const line = data.subarray(0, newline).toString("utf-8").trim();
    if (!line) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== "object") return null;
    const header = parsed as { type?: unknown; id?: unknown };
    if (header.type !== "session" || typeof header.id !== "string" || header.id.length === 0) return null;
    return header.id;
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

export function ensurePartitionDir(sessionDir: string): void {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  // Reject a partition replaced by a symlink — lexical containment cannot
  // see through it, and the conversation files would live outside the
  // authorized root.
  const stat = lstatSync(sessionDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("conversation partition is not a regular directory");
  }
}

/**
 * All files in the partition claiming this conversation ID. Pi names files
 * `<timestamp>_<id>.jsonl`, so location comes from discovery, never from a
 * constructed filename. More than one claimant is an ambiguous duplicate
 * and fails closed.
 */
export function findOwnedClaimants(sessionDir: string, conversationId: string): string[] {
  let names: string[];
  try {
    names = readdirSync(sessionDir);
  } catch {
    return [];
  }
  const claimants: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const candidate = join(sessionDir, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(candidate);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (readPiSessionHeaderId(candidate) === conversationId) claimants.push(candidate);
  }
  return claimants;
}

export type PiOwnedFileStatus = "intact" | "missing" | "corrupt" | "ambiguous";

export interface PiOwnedFileInspection {
  status: PiOwnedFileStatus;
  canonicalFile: string | null;
  reason?: string;
}

/**
 * Inspect one owned conversation file without adopting it. Claimant scan
 * plus header/containment checks; a corrupt or missing result never opens
 * the file. Never a global latest-session scan or an unscoped suffix
 * search: the partition directory bounds everything.
 *
 * knownFile is the previously recorded path (binding/row): when discovery
 * finds no header-matching claimant but the recorded file still exists,
 * its header decides corrupt (mismatch/unreadable) rather than missing —
 * a fully overwritten first line is corruption evidence, not absence.
 */
export function inspectOwnedConversationFile(
  storageRoot: string,
  sessionDir: string,
  conversationId: string,
  knownFile?: string,
): PiOwnedFileInspection {
  if (!isValidPiConversationId(conversationId)) {
    return { status: "corrupt", canonicalFile: null, reason: "invalid conversation id" };
  }
  try {
    ensurePartitionDir(sessionDir);
  } catch (err) {
    return {
      status: "corrupt",
      canonicalFile: null,
      reason: err instanceof Error ? err.message : "conversation partition unavailable",
    };
  }
  const claimants = findOwnedClaimants(sessionDir, conversationId);
  if (claimants.length === 0) {
    // Containment first: a recorded path outside the root is never
    // touched — the binding itself is untrustworthy.
    if (knownFile !== undefined && isPathWithinRoot(storageRoot, knownFile)) {
      let knownStat: ReturnType<typeof statSync> | null = null;
      try {
        knownStat = statSync(knownFile);
      } catch {
        knownStat = null;
      }
      if (knownStat !== null && knownStat.isFile() && !lstatSync(knownFile).isSymbolicLink()) {
        const verified = verifyPiConversationFile(storageRoot, sessionDir, conversationId, knownFile, readPiSessionHeaderId);
        return {
          status: "corrupt",
          canonicalFile: knownFile,
          reason: verified.ok ? "recorded file no longer claims the conversation" : verified.reason,
        };
      }
    }
    return { status: "missing", canonicalFile: null };
  }
  if (claimants.length !== 1 || claimants[0] === undefined) {
    return {
      status: "ambiguous",
      canonicalFile: claimants[0] ?? null,
      reason: "ambiguous duplicate conversation files for one id",
    };
  }
  const candidate = claimants[0];
  const verified = verifyPiConversationFile(storageRoot, sessionDir, conversationId, candidate, readPiSessionHeaderId);
  if (!verified.ok) {
    return { status: "corrupt", canonicalFile: candidate, reason: verified.reason };
  }
  if (verified.canonicalFile !== candidate) {
    return { status: "corrupt", canonicalFile: candidate, reason: "discovered file is outside the authorized partition" };
  }
  return { status: "intact", canonicalFile: candidate };
}

/**
 * Quarantine a corrupt owned file without overwriting source data. The file
 * is renamed beside its partition path; the caller allocates and readies a
 * successor before retiring the predecessor.
 */
export function quarantineOwnedConversationFile(
  storageRoot: string,
  canonicalFile: string,
): string {
  if (!isPathWithinRoot(storageRoot, canonicalFile)) {
    throw new Error("refusing to quarantine a file outside the authorized root");
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(canonicalFile);
  } catch (err) {
    throw new Error(`quarantine target unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("refusing to quarantine a non-regular file");
  }
  const quarantined = `${canonicalFile}.quarantined-${Date.now()}`;
  try {
    renameSync(canonicalFile, quarantined);
  } catch (err) {
    throw new Error(`quarantine rename failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return quarantined;
}

/** Minimal structural append surface of a Pi SessionManager instance. */
export interface PiArchiveSeedTarget {
  appendMessage(message: { role: string; content: unknown; [key: string]: unknown }): string;
}

export interface PiSeedMessageInput {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

function seedUsage(): Record<string, unknown> {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Wrap a Pi SessionManager instance as a reconstruction seed writer.
 * Archive context enters as ordinary user/assistant turns through the
 * public append API; no private entry rewriting, no tool replay. Seeded
 * assistant turns carry zero usage and a synthetic provider identity —
 * they are declared reconstruction losses made visible, not live model
 * output.
 */
export function seedWriterForSessionManager(instance: PiArchiveSeedTarget): {
  appendSeed: (message: PiSeedMessageInput) => void;
} {
  return {
    appendSeed: (message: PiSeedMessageInput) => {
      const content = [{ type: "text" as const, text: message.text }];
      if (message.role === "user") {
        instance.appendMessage({ role: "user", content, timestamp: message.timestamp });
        return;
      }
      instance.appendMessage({
        role: "assistant",
        content,
        api: "openai-completions",
        provider: "abmind",
        model: "historical",
        usage: seedUsage(),
        stopReason: "stop",
        timestamp: message.timestamp,
      });
    },
  };
}

export interface PiReseedProgress {
  seeded: number;
  currentAdmitted: boolean;
  /** Crash-safe same-successor resume: the allocated successor ID. */
  successorId?: string;
}

function progressPath(progressDir: string, conversationId: string): string {
  return join(progressDir, `${conversationId}.reseed.json`);
}

/**
 * Crash-safe reseed progress beside the bindings (not in them): the seed
 * boundary and current-input admission survive a crash, so a retried
 * reconstruction after restart resumes the same successor, skips
 * already-seeded history, and never replays the current input.
 */
export function loadPiReseedProgress(progressDir: string, conversationId: string): PiReseedProgress {
  let raw: string;
  try {
    raw = readFileSync(progressPath(progressDir, conversationId), "utf-8");
  } catch {
    return { seeded: 0, currentAdmitted: false };
  }
  if (raw.length > 64 * 1024) {
    logWarn(TAG, "reseed progress exceeds size bound; restarting");
    return { seeded: 0, currentAdmitted: false };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PiReseedProgress>;
    return {
      seeded: typeof parsed.seeded === "number" && parsed.seeded >= 0 ? Math.floor(parsed.seeded) : 0,
      currentAdmitted: parsed.currentAdmitted === true,
      ...(typeof parsed.successorId === "string" && parsed.successorId.length > 0 ? { successorId: parsed.successorId } : {}),
    };
  } catch {
    logWarn(TAG, "reseed progress unreadable; restarting");
    return { seeded: 0, currentAdmitted: false };
  }
}

export function savePiReseedProgress(progressDir: string, conversationId: string, progress: PiReseedProgress): void {
  mkdirSync(progressDir, { recursive: true, mode: 0o700 });
  const path = progressPath(progressDir, conversationId);
  const tmp = `${path}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(progress), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    logWarn(TAG, `reseed progress unwritable: ${err instanceof Error ? err.message : String(err)}`);
  }
}
