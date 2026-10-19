import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
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

export function resolvePiConversationFile(sessionDir: string, conversationId: string): string {
  return join(sessionDir, `${conversationId}.jsonl`);
}

/**
 * Exact-ID lookup within the authorized partition. Never a global
 * latest-session scan or an unscoped suffix search: the candidate file is
 * derived from the directory and ID, then containment and header identity
 * are enforced.
 */
export function verifyPiConversationFile(
  root: string,
  sessionDir: string,
  conversationId: string,
  readHeaderId: (canonicalFile: string) => string | null,
): PiConversationFileResolution {
  if (!isValidPiConversationId(conversationId)) {
    return { ok: false, reason: "invalid conversation id" };
  }
  const candidate = resolvePiConversationFile(sessionDir, conversationId);
  if (!isPathWithinRoot(root, candidate)) {
    return { ok: false, reason: "conversation file escapes authorized root" };
  }
  if (!isPathWithinRoot(sessionDir, candidate)) {
    return { ok: false, reason: "conversation file escapes authorized partition" };
  }
  if (!existsSync(candidate)) {
    return { ok: false, reason: "conversation file not found" };
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(candidate);
  } catch {
    // Race between existence check and stat: fail closed as missing.
    return { ok: false, reason: "conversation file unreadable" };
  }
  if (!stat.isFile()) {
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
