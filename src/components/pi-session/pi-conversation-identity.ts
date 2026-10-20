import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isPathWithinRoot } from "../workspace-paths.js";

/** Pi accepts IDs matching its assertValidSessionId contract. */
const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export type PiConversationRole =
  | "main"
  | "orc"
  | "worker"
  | "browsing"
  | "coding"
  | "task"
  | "peer"
  | "dreamy"
  | "healer"
  | "maintenance"
  | "skill-isolated";

export type PiMemoryScope = "abmind" | "none" | "skill-isolated";

export interface PiConversationParams {
  principal: string;
  platform: string;
  role: PiConversationRole;
  workspaceAlias: string;
  canonicalWorkspace: string;
  memoryScope: PiMemoryScope;
}

export interface PiConversationBinding {
  conversationId: string;
  principal: string;
  platform: string;
  role: PiConversationRole;
  workspaceAlias: string;
  canonicalWorkspace: string;
  memoryScope: PiMemoryScope;
  sessionDir: string;
  predecessorId?: string;
}

/** Result of resolving or verifying a conversation file on disk. */
export type PiConversationFileResolution =
  | { ok: true; canonicalFile: string }
  | { ok: false; reason: string };

export function isValidPiConversationId(id: string): boolean {
  return PI_SESSION_ID_PATTERN.test(id);
}

/**
 * Mint a durable conversation ID accepted by Pi. randomUUID is unique across
 * daemon restarts and matches Pi's assertValidSessionId character contract.
 */
export function mintPiConversationId(): string {
  return randomUUID();
}

/** Opaque partition key: stable sha256 prefix, never the raw principal. */
export function opaquePrincipalKey(principal: string): string {
  return createHash("sha256").update(principal, "utf8").digest("hex").slice(0, 16);
}

/** Canonical workspace key: stable hash of the canonical path. */
export function canonicalWorkspaceKey(canonicalWorkspace: string): string {
  return createHash("sha256").update(canonicalWorkspace, "utf8").digest("hex").slice(0, 16);
}

export function resolvePiConversationDir(
  root: string,
  principal: string,
  role: PiConversationRole,
  canonicalWorkspace: string,
): string {
  return join(root, opaquePrincipalKey(principal), role, canonicalWorkspaceKey(canonicalWorkspace));
}

/**
 * Exact-ID verification of a discovered candidate file. Discovery comes
 * from Pi's findById plus the adapter's claimant scan; this function
 * enforces containment, symlink rejection, and header identity on the
 * candidate. Never a global latest-session scan or an unscoped suffix
 * search. Symlinks are rejected outright: a link inside the partition
 * could otherwise resolve to a file outside it while passing lexical
 * containment (R2 requires canonical containment before opening).
 */
export function verifyPiConversationFile(
  root: string,
  sessionDir: string,
  conversationId: string,
  candidate: string,
  readHeaderId: (canonicalFile: string) => string | null,
): PiConversationFileResolution {
  if (!isValidPiConversationId(conversationId)) {
    return { ok: false, reason: "invalid conversation id" };
  }
  if (!isPathWithinRoot(root, candidate)) {
    return { ok: false, reason: "conversation file escapes authorized root" };
  }
  if (!isPathWithinRoot(sessionDir, candidate)) {
    return { ok: false, reason: "conversation file escapes authorized partition" };
  }
  if (!existsSync(candidate)) {
    return { ok: false, reason: "conversation file not found" };
  }
  let linkStat: ReturnType<typeof lstatSync>;
  try {
    linkStat = lstatSync(candidate);
  } catch {
    return { ok: false, reason: "conversation file unreadable" };
  }
  if (linkStat.isSymbolicLink()) {
    return { ok: false, reason: "conversation file is a symlink" };
  }
  if (!linkStat.isFile()) {
    return { ok: false, reason: "conversation path is not a regular file" };
  }
  const headerId = readHeaderId(candidate);
  if (headerId === null) {
    return { ok: false, reason: "conversation header unreadable" };
  }
  if (headerId !== conversationId) {
    return { ok: false, reason: "header id does not match conversation id" };
  }
  return { ok: true, canonicalFile: candidate };
}

/**
 * Allocate a successor after loss/corruption. The fresh ID carries
 * authorized source lineage; the predecessor binding is retired only when
 * the successor is ready (enforced by the caller).
 */
export function allocatePiSuccessor(predecessor: PiConversationBinding): PiConversationBinding {
  return {
    ...predecessor,
    conversationId: mintPiConversationId(),
    predecessorId: predecessor.conversationId,
  };
}

/** Owned-session launch identity: the caller supplies role + conversation ID;
 * principal and workspace come from the already-resolved execution context. */
export interface PiOwnedSessionLaunch {
  principal: string;
  role: PiConversationRole;
  canonicalWorkspace: string;
  conversationId: string;
}

export type PiOwnedSessionLaunchArgs =
  | { ok: true; sessionDir: string; args: readonly string[] }
  | { ok: false; reason: string };

const PI_CONVERSATION_ROLES: readonly PiConversationRole[] = [
  "main",
  "orc",
  "worker",
  "browsing",
  "coding",
  "task",
  "peer",
  "dreamy",
  "healer",
  "maintenance",
  "skill-isolated",
];

/**
 * Build the RPC/Pi launch vector for an owned conversation: the partitioned
 * session dir plus the exact abtars-minted conversation ID. The same spelling
 * is shared by in-process open (adapter), RPC launch, and native handoff so
 * SDK, RPC, and handoff resolve the same directory and ID (R1-R2). Failures
 * are explicit so the caller fails closed instead of silently launching into
 * the flat shared root under a different identity.
 */
export function buildOwnedSessionLaunchArgs(
  root: string,
  launch: PiOwnedSessionLaunch,
): PiOwnedSessionLaunchArgs {
  if (!root || !launch.principal || !launch.canonicalWorkspace) {
    return { ok: false, reason: "owned session launch requires root, principal, and workspace" };
  }
  if (!PI_CONVERSATION_ROLES.includes(launch.role)) {
    return { ok: false, reason: "owned session launch requires a known conversation role" };
  }
  if (!isValidPiConversationId(launch.conversationId)) {
    return { ok: false, reason: "owned session launch requires a valid conversation id" };
  }
  const sessionDir = resolvePiConversationDir(root, launch.principal, launch.role, launch.canonicalWorkspace);
  if (!isPathWithinRoot(root, sessionDir)) {
    return { ok: false, reason: "owned session directory escapes the authorized root" };
  }
  return { ok: true, sessionDir, args: ["--session-dir", sessionDir, "--session-id", launch.conversationId] };
}

// ── Legacy in-process binding sweep (#1940) ──────────────────────────────
// The AgentSession route mints no bindings: sessions are in-memory and
// continuity comes from abmind hydration. These helpers exist only so
// retention can drain binding files left by pre-#1940 daemons.

/** Durable bindings directory beneath the abtars state dir (one file per session key). */
const BINDINGS_DIRNAME = "pi-sdk-conversations-v1";
const BINDING_VERSION = 1;
/** Bounded read: a binding is a small record, never a transcript. */
const MAX_BINDING_BYTES = 64 * 1024;

export interface SdkConversationBinding {
  conversationId: string;
  sessionDir: string;
  sessionFile?: string;
  role: PiConversationRole;
  principal: string;
  platform: string;
  workspaceAlias: string;
  updatedAt: number;
}

interface BindingFileShape {
  version: number;
  sessionKey: string;
  binding: SdkConversationBinding;
}

export interface SdkStoredBinding {
  sessionKey: string;
  binding: SdkConversationBinding;
}

/**
 * List all durable bindings (tolerant: skips unreadable entries).
 * Retention's binding sweep is the only production consumer.
 */
export function listSdkBindings(stateDir: string): SdkStoredBinding[] {
  const dir = join(stateDir, BINDINGS_DIRNAME);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const bindings: SdkStoredBinding[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let stat: ReturnType<typeof lstatSync> | null = null;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) continue;
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    if (raw.length > MAX_BINDING_BYTES) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<BindingFileShape>;
      if (parsed.version !== BINDING_VERSION || typeof parsed.sessionKey !== "string") continue;
      const binding = parsed.binding;
      if (!binding || typeof binding !== "object" || !isValidPiConversationId(binding.conversationId)) continue;
      bindings.push({ sessionKey: parsed.sessionKey, binding: binding as SdkConversationBinding });
    } catch {
      continue;
    }
  }
  return bindings;
}

/** Delete one binding record (retention only; never touches Pi files). */
export function deleteSdkBinding(stateDir: string, sessionKey: string): boolean {
  const name = createHash("sha256").update(sessionKey, "utf8").digest("hex");
  const path = join(stateDir, BINDINGS_DIRNAME, `${name}.json`);
  try {
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}
