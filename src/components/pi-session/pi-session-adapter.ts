import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { logWarn } from "../logger.js";
import {
  isValidPiConversationId,
  mintPiConversationId,
  resolvePiConversationDir,
  verifyPiConversationFile,
  type PiConversationBinding,
  type PiConversationParams,
} from "./pi-conversation-identity.js";

export type { PiConversationBinding, PiConversationParams };

const TAG = "pi-session-adapter";
const REGISTRY_FILENAME = "pi-conversations-v1.json";
const ENDED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 5_000;
const HEADER_READ_MAX_BYTES = 64 * 1024;

/**
 * Structural Pi SDK surface used by the adapter. Production code loads the
 * real module through installed-Pi discovery (never a static runtime import,
 * enforced by check-pi-boundary); tests inject fakes.
 */
export interface PiSessionManagerShape {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getSessionDir(): string;
}

export interface PiSessionManagerCtor {
  create(cwd: string, sessionDir?: string, options?: { id?: string; parentSession?: string }): PiSessionManagerShape;
  open(path: string, sessionDir?: string, cwdOverride?: string): PiSessionManagerShape;
  findById(cwd: string, id: string, sessionDir?: string): string | undefined;
  forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string, options?: { id?: string }): PiSessionManagerShape;
}

/** Minimal AgentSession surface: queue drain, abort, idle, subscriptions. */
export interface PiAgentSessionShape {
  clearQueue(): { steering: string[]; followUp: string[] };
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  on(event: string, handler: (event: { type: string }) => void): () => void;
}

export interface PiConversationHandle {
  binding: PiConversationBinding;
  /**
   * Null until Pi flushes the session file. Pi creates the file only once
   * the session holds a user or assistant message, so a freshly created
   * conversation has no file yet. Fork and reconstruction require history
   * and fail clearly while unflushed.
   */
  canonicalFile: string | null;
  generation: number;
  admissionOpen: boolean;
}

export interface PiCancelResult {
  drainedSteering: string[];
  drainedFollowUp: string[];
  settled: boolean;
}

/** agent_settled ends model activity; agent_end can precede automatic recovery. */
export type PiMappedEvent = "terminal" | "recovery" | "progress" | "ignored";

export function mapPiEventType(type: string): PiMappedEvent {
  if (type === "agent_settled") return "terminal";
  if (type === "agent_end") return "recovery";
  if (type === "session_compact" || type === "session_compact_failed" || type === "compaction_start" || type === "compaction_end") {
    return "progress";
  }
  return "ignored";
}

export function isTerminalPiEvent(type: string): boolean {
  return mapPiEventType(type) === "terminal";
}

/** Bounded, content-free header read: first JSONL record id or null. */
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

export function allocatePiBinding(
  stateRoot: string,
  params: PiConversationParams,
): PiConversationBinding {
  const conversationId = mintPiConversationId();
  const sessionDir = resolvePiConversationDir(stateRoot, params.principal, params.role, params.canonicalWorkspace);
  return {
    conversationId,
    principal: params.principal,
    platform: params.platform,
    role: params.role,
    workspaceAlias: params.workspaceAlias,
    canonicalWorkspace: params.canonicalWorkspace,
    memoryScope: params.memoryScope,
    sessionDir,
  };
}

function ensurePartitionDir(sessionDir: string): void {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
}

/**
 * All files in the partition claiming this conversation ID. Pi names files
 * `<timestamp>_<id>.jsonl`, so location comes from discovery, never from a
 * constructed filename. More than one claimant is an ambiguous duplicate
 * and fails closed.
 */
function findClaimants(sessionDir: string, conversationId: string): string[] {
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

function verifyOwned(
  stateRoot: string,
  binding: PiConversationBinding,
  candidate: string,
): { ok: true; canonicalFile: string } | { ok: false; reason: string } {
  const verified = verifyPiConversationFile(stateRoot, binding.sessionDir, binding.conversationId, candidate, readPiSessionHeaderId);
  if (!verified.ok) return verified;
  if (verified.canonicalFile !== candidate) {
    // Discovery pointed outside the authorized partition layout.
    return { ok: false, reason: "discovered file is outside the authorized partition" };
  }
  return { ok: true, canonicalFile: candidate };
}

/**
 * Open an intact conversation under its existing ID, or create it with the
 * abtars-minted ID when absent. Exact-ID discovery only: findById plus an
 * independent header/containment check, never a global latest-session scan
 * or an unscoped suffix search. A fresh conversation has no file until Pi
 * flushes its first message; the handle reports canonicalFile null then.
 */
export function openPiConversation(
  sessionManager: PiSessionManagerCtor,
  stateRoot: string,
  binding: PiConversationBinding,
): PiConversationHandle {
  if (!isValidPiConversationId(binding.conversationId)) {
    throw new Error("refusing to open conversation with invalid id");
  }
  assertOwnerClear(stateRoot, binding);
  ensurePartitionDir(binding.sessionDir);
  const found = sessionManager.findById(binding.canonicalWorkspace, binding.conversationId, binding.sessionDir);
  if (found !== undefined) {
    const claimants = findClaimants(binding.sessionDir, binding.conversationId);
    if (claimants.length !== 1 || claimants[0] !== found) {
      throw new Error("ambiguous duplicate conversation files for one id");
    }
    const verified = verifyOwned(stateRoot, binding, found);
    if (!verified.ok) {
      // Missing or corrupt files are closed/quarantined, never silently adopted.
      throw new Error(`owned conversation file failed verification (${verified.reason})`);
    }
    sessionManager.open(verified.canonicalFile, binding.sessionDir, binding.canonicalWorkspace);
    registerConversation(stateRoot, binding, verified.canonicalFile);
    return { binding, canonicalFile: verified.canonicalFile, generation: 1, admissionOpen: true };
  }
  const created = sessionManager.create(binding.canonicalWorkspace, binding.sessionDir, { id: binding.conversationId });
  if (created.getSessionId() !== binding.conversationId) {
    throw new Error("Pi session id does not match the abtars-allocated conversation id");
  }
  // Pi assigns the file path eagerly but writes it only once the session
  // holds a user or assistant message. Report null until a verified file
  // exists; the next open after the first message discovers it. A foreign
  // file already sitting at the assigned path is a collision: fail closed.
  const expectedFile = created.getSessionFile() ?? null;
  if (expectedFile !== null && existsSync(expectedFile)) {
    const verified = verifyOwned(stateRoot, binding, expectedFile);
    if (!verified.ok) {
      throw new Error(`new conversation file failed verification (${verified.reason})`);
    }
    registerConversation(stateRoot, binding, verified.canonicalFile);
    return { binding, canonicalFile: verified.canonicalFile, generation: 1, admissionOpen: true };
  }
  registerConversation(stateRoot, binding, null);
  return { binding, canonicalFile: null, generation: 1, admissionOpen: true };
}

/**
 * Fork through abtars allocation first: the successor binding (fresh ID,
 * predecessor lineage) must exist before any Pi fork call, so native or
 * extension forks cannot create addressable unregistered conversations.
 * The source must have flushed history; an unflushed source has nothing
 * to fork and fails with an explicit error.
 */
export function forkPiConversation(
  sessionManager: PiSessionManagerCtor,
  stateRoot: string,
  source: PiConversationHandle,
  successor: PiConversationBinding,
): PiConversationHandle {
  if (successor.predecessorId !== source.binding.conversationId) {
    throw new Error("fork successor must carry the source conversation as predecessor");
  }
  assertOwnerClear(stateRoot, successor);
  if (source.canonicalFile === null) {
    throw new Error("cannot fork a source with no persisted history yet");
  }
  const verified = verifyOwned(stateRoot, source.binding, source.canonicalFile);
  if (!verified.ok) {
    throw new Error(`cannot fork from unverified source (${verified.reason})`);
  }
  ensurePartitionDir(successor.sessionDir);
  const forked = sessionManager.forkFrom(verified.canonicalFile, successor.canonicalWorkspace, successor.sessionDir, {
    id: successor.conversationId,
  });
  if (forked.getSessionId() !== successor.conversationId) {
    throw new Error("Pi fork id does not match the abtars-allocated successor id");
  }
  const forkedFile = forked.getSessionFile() ?? sessionManager.findById(
    successor.canonicalWorkspace,
    successor.conversationId,
    successor.sessionDir,
  );
  if (forkedFile === undefined) {
    throw new Error("forked conversation has no discoverable file");
  }
  const claimants = findClaimants(successor.sessionDir, successor.conversationId);
  if (!claimants.includes(forkedFile)) {
    throw new Error("forked conversation failed verification (undiscoverable file)");
  }
  if (readPiSessionHeaderId(forkedFile) !== successor.conversationId) {
    throw new Error("forked conversation failed verification (header mismatch)");
  }
  registerConversation(stateRoot, successor, forkedFile);
  return { binding: successor, canonicalFile: forkedFile, generation: 1, admissionOpen: true };
}

/** Close per-execution steering admission before cancellation. */
export function closePiAdmission(handle: PiConversationHandle): void {
  handle.admissionOpen = false;
}

/**
 * Cancel under the closed gate: drain both Pi queues explicitly (abort
 * alone does not clear steering/follow-up), abort active work, then await
 * logical idleness within the existing cleanup bound. Late submissions
 * stay fenced by the caller's execution generation. Abort failures
 * propagate; an idle timeout reports settled:false instead of throwing.
 */
export async function cancelPiConversation(
  session: PiAgentSessionShape,
  handle: PiConversationHandle,
  idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
): Promise<PiCancelResult> {
  closePiAdmission(handle);
  const drained = session.clearQueue();
  await session.abort();
  const settled = await waitForPiIdle(session, idleTimeoutMs);
  return { drainedSteering: drained.steering, drainedFollowUp: drained.followUp, settled };
}

async function waitForPiIdle(session: PiAgentSessionShape, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idleWon = false;
  try {
    await Promise.race([
      session.waitForIdle().then(() => {
        idleWon = true;
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    return idleWon;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Bind observers to the replacement instance before it can run; the caller
 * holds the returned unbind and detaches the old subscription first.
 */
export function bindPiObservers(
  session: PiAgentSessionShape,
  onEvent: (type: string) => void,
): () => void {
  const unbinds = [
    session.on("agent_settled", (event) => onEvent(event.type)),
    session.on("agent_end", (event) => onEvent(event.type)),
    session.on("session_compact", (event) => onEvent(event.type)),
  ];
  return () => {
    for (const unbind of unbinds) unbind();
  };
}

// ── Owned-conversation registry, retention, and erasure ──

interface PiConversationRecord {
  sessionDir: string;
  canonicalFile: string | null;
  principal: string;
  platform: string;
  role: string;
  canonicalWorkspace: string;
  predecessorId?: string;
  endedAt?: number;
  reseed?: PiReseedProgress;
}

export interface PiReseedProgress {
  seeded: number;
  currentAdmitted: boolean;
}

interface PiConversationRegistry {
  version: 1;
  conversations: Record<string, PiConversationRecord>;
}

function registryPath(stateRoot: string): string {
  return join(stateRoot, REGISTRY_FILENAME);
}

function loadRegistry(stateRoot: string): PiConversationRegistry {
  const path = registryPath(stateRoot);
  if (!existsSync(path)) return { version: 1, conversations: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as PiConversationRegistry;
    if (parsed.version !== 1 || parsed.conversations === null || typeof parsed.conversations !== "object") {
      logWarn(TAG, "conversation registry has unsupported shape; using empty registry");
      return { version: 1, conversations: {} };
    }
    return parsed;
  } catch {
    logWarn(TAG, "conversation registry unreadable; using empty registry");
    return { version: 1, conversations: {} };
  }
}

function saveRegistry(stateRoot: string, registry: PiConversationRegistry): void {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const path = registryPath(stateRoot);
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(registry), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Cross-principal/role denial: a conversation ID owned by one
 * principal/platform/role is never addressable under another. Same-owner
 * reopen is the normal path and passes.
 */
function assertOwnerClear(stateRoot: string, binding: PiConversationBinding): void {
  const registry = loadRegistry(stateRoot);
  const record = registry.conversations[binding.conversationId];
  if (!record) return;
  if (record.principal !== binding.principal || record.platform !== binding.platform || record.role !== binding.role) {
    throw new Error("conversation id is owned by a different principal or role");
  }
}

function registerConversation(stateRoot: string, binding: PiConversationBinding, canonicalFile: string | null): void {
  const registry = loadRegistry(stateRoot);
  registry.conversations[binding.conversationId] = {
    sessionDir: binding.sessionDir,
    canonicalFile,
    principal: binding.principal,
    platform: binding.platform,
    role: binding.role,
    canonicalWorkspace: binding.canonicalWorkspace,
    predecessorId: binding.predecessorId,
  };
  saveRegistry(stateRoot, registry);
}

/** Mark a conversation ended; retention sweep only prunes ended sessions. */
export function markPiConversationEnded(stateRoot: string, conversationId: string, now: number): void {
  const registry = loadRegistry(stateRoot);
  const record = registry.conversations[conversationId];
  if (!record) return;
  record.endedAt = now;
  saveRegistry(stateRoot, registry);
}

/**
 * Registry-backed reconstruction progress: the seed boundary and current
 * input admission survive a crash in the owned registry, so a retried
 * reconstruction after restart skips already-seeded history and never
 * replays the current input.
 */
export function loadPiReseedProgress(stateRoot: string, conversationId: string): PiReseedProgress {
  const registry = loadRegistry(stateRoot);
  return registry.conversations[conversationId]?.reseed ?? { seeded: 0, currentAdmitted: false };
}

export function savePiReseedProgress(stateRoot: string, conversationId: string, progress: PiReseedProgress): void {
  const registry = loadRegistry(stateRoot);
  const record = registry.conversations[conversationId];
  if (!record) return;
  record.reseed = { ...progress };
  saveRegistry(stateRoot, registry);
}

/** Minimal structural append surface of a Pi SessionManager instance. */
export interface PiArchiveSeedTarget {
  appendMessage(message: {
    role: "user" | "assistant";
    content: Array<{ type: "text"; text: string }>;
    timestamp: number;
  }): string;
}

export interface PiSeedMessageInput {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

/**
 * Wrap a Pi SessionManager instance as a reconstruction seed writer.
 * Archive context enters as ordinary user/assistant turns through the
 * public append API; no private entry rewriting, no tool replay.
 */
export function seedWriterForSessionManager(instance: PiArchiveSeedTarget): {
  appendSeed: (message: PiSeedMessageInput) => void;
} {
  return {
    appendSeed: (message: PiSeedMessageInput) => {
      instance.appendMessage({
        role: message.role,
        content: [{ type: "text", text: message.text }],
        timestamp: message.timestamp,
      });
    },
  };
}

export interface PiRetentionReport {
  removed: string[];
  kept: string[];
}

/**
 * Seven-day ended-session retention over registered abtars-owned files
 * only. Never sweeps standalone Pi session directories. Preserves live
 * writers, resumable active work (isActive), unflushed registrations, and
 * delivery-referenced conversations regardless of age. Event-driven: the
 * caller invokes this at session lifecycle/startup boundaries.
 */
export function sweepPiRetention(
  stateRoot: string,
  now: number,
  isActive: (conversationId: string) => boolean,
): PiRetentionReport {
  const registry = loadRegistry(stateRoot);
  const removed: string[] = [];
  const kept: string[] = [];
  let changed = false;
  for (const [conversationId, record] of Object.entries(registry.conversations)) {
    if (record.canonicalFile === null) {
      kept.push(conversationId);
      continue;
    }
    if (record.endedAt === undefined || now - record.endedAt < ENDED_RETENTION_MS) {
      kept.push(conversationId);
      continue;
    }
    if (isActive(conversationId)) {
      kept.push(conversationId);
      continue;
    }
    if (!record.canonicalFile.startsWith(join(stateRoot, ""))) {
      // Not abtars-owned: never delete, keep the record for inspection.
      logWarn(TAG, `retention skipped non-owned record for "${conversationId}"`);
      kept.push(conversationId);
      continue;
    }
    removeOwnedFiles(record.canonicalFile);
    removed.push(conversationId);
    delete registry.conversations[conversationId];
    changed = true;
  }
  if (changed) saveRegistry(stateRoot, registry);
  return { removed, kept };
}

function removeOwnedFiles(canonicalFile: string): void {
  for (const candidate of [canonicalFile, `${canonicalFile}.quarantined`]) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) rmSync(candidate);
    } catch {
      // Best-effort file removal: the registry entry is already dropped so
      // a later sweep retries; never throw out of retention.
      logWarn(TAG, `retention could not remove "${dirname(candidate)}" entry`);
    }
  }
}

export interface PiErasureReport {
  removedFiles: string[];
}

/**
 * Explicit session erasure: removes owned files and derivatives/quarantine
 * without touching standalone Pi sessions. Content-free workflow/delivery
 * metadata stays with its existing owners; only the registry entry drops.
 */
export function erasePiConversation(stateRoot: string, conversationId: string): PiErasureReport {
  const registry = loadRegistry(stateRoot);
  const record = registry.conversations[conversationId];
  if (!record) return { removedFiles: [] };
  if (record.canonicalFile !== null && !record.canonicalFile.startsWith(join(stateRoot, ""))) {
    throw new Error("refusing to erase a conversation outside the owned root");
  }
  const removedFiles: string[] = [];
  if (record.canonicalFile !== null) {
    for (const candidate of [record.canonicalFile, `${record.canonicalFile}.quarantined`]) {
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          rmSync(candidate);
          removedFiles.push(candidate);
        }
      } catch {
        logWarn(TAG, "erasure could not remove an owned file");
      }
    }
  }
  delete registry.conversations[conversationId];
  saveRegistry(stateRoot, registry);
  return { removedFiles };
}
