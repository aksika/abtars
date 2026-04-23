import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logInfo, logWarn } from "./logger.js";
import { agentBridgeHome } from "../paths.js";
import { loadUsers, buildUsersBlock } from "./user-registry.js";
import type { MemoryManager } from "abmind/memory-manager.js";

const TAG = "soul-loader";
const HOST_CORE_DIR = join(agentBridgeHome(), "core");

/** Read a single file, return empty string on failure. */
function readOr(path: string): string {
  try { return existsSync(path) ? readFileSync(path, "utf-8").trim() : ""; } catch { return ""; }
}

/**
 * Build the session injection bundle: abmind 4 + host 2.
 *
 * abmind files via memory.getSessionBundle() (SOUL, profile, notes, memory-tools).
 * Transition fallback: if memory unavailable or file missing, reads from ~/.agentbridge/core/.
 * Host files (core_facts.md, skills_catalog.md) always from ~/.agentbridge/core/.
 * Appends [USERS] block.
 */
export function loadSoulBundle(memory?: MemoryManager | null): string | null {
  const parts: string[] = [];

  // abmind 4 — prefer getSessionBundle(), fall back to host core dir
  let bundle: { soul: string; profile: string; notes: string; memoryTools: string } | null = null;
  try { bundle = memory?.getSessionBundle() ?? null; } catch { /* memory not ready */ }

  const soul = bundle?.soul || readOr(join(HOST_CORE_DIR, "SOUL.md"));
  const profile = bundle?.profile || readOr(join(HOST_CORE_DIR, "user_profile.md"));
  const notes = bundle?.notes || readOr(join(HOST_CORE_DIR, "agent_notes.md"));
  const memoryTools = bundle?.memoryTools || readOr(join(HOST_CORE_DIR, "TOOLS.md"));

  if (soul) parts.push(soul);
  if (memoryTools) parts.push(memoryTools);
  if (profile) parts.push(profile);
  if (notes) parts.push(notes);

  // Host 2
  const coreFacts = readOr(join(HOST_CORE_DIR, "core_facts.md"));
  if (coreFacts) parts.push(coreFacts);
  const skillsCatalog = readOr(join(HOST_CORE_DIR, "skills_catalog.md"));
  if (skillsCatalog) parts.push(skillsCatalog);

  // [USERS] block
  try {
    const registry = loadUsers();
    if (registry.users.length > 0) parts.push(buildUsersBlock(registry));
  } catch { /* user registry not available */ }

  if (parts.length === 0) {
    logWarn(TAG, "No session bundle files found");
    return null;
  }

  logInfo(TAG, `Session bundle: ${parts.length} parts (abmind: ${bundle ? "API" : "fallback"})`);
  return parts.join("\n\n---\n\n");
}
