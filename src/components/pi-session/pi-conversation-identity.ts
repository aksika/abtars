import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
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
