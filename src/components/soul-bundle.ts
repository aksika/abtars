/**
 * soul-bundle.ts — Unified SOUL bundle builder for all session types.
 * One function, one matrix. Replaces scattered injection logic.
 */
import { logAndSwallow } from "./log-and-swallow.js";
import { getEnv } from "./env-schema.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logInfo, logDebug, logWarn } from "./logger.js";
import { abtarsHome } from "../paths.js";
import { loadUsers, buildUsersBlock } from "./user-registry.js";
import type { MemoryManager } from "abmind";
import type { SessionType } from "./session-manager.js";

const TAG = "soul-bundle";
const HOST_CORE_DIR = join(abtarsHome(), "core");

function readOr(path: string): string {
  try { return existsSync(path) ? readFileSync(path, "utf-8").trim() : ""; } catch { return ""; }
}

/** Type identity — hardcoded one-liners for non-Main sessions. */
const TYPE_IDENTITY: Record<SessionType, string | null> = {
  A: null, // uses full SOUL.md
  B: "I am a browse agent. I fetch web content and return results. No memory access.",
  C: "I am a coding agent. I write and fix code. Be concise.",
  T: "I am a task agent. I execute scheduled tasks. Write all output to $WORKSPACE.",
  S: "I am the self-healing agent. I diagnose and fix system failures. If unfixable, state: Requires human intervention.",
  P: "I am responding to a peer agent request. Be precise and technical.",
};

function buildModelInstructions(): string {
  const lines: string[] = [];
  if (getEnv().primingModelTopics) {
    lines.push("End each response with [TOPICS: kw1, kw2, kw3] — your top 3 topics from this exchange. Keep them English, lowercase, concise.");
  }
  return lines.length > 0 ? `# Model Instructions\n\n${lines.join("\n")}` : "";
}

function buildCurrentTime(): string {
  const now = new Date();
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return `[CURRENT TIME] ${now.toLocaleDateString("en-GB")} ${days[now.getDay()]}, ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * Build the SOUL bundle for any session type.
 *
 * Main (A): full 9-part bundle (identity, tools, profile, notes, facts, skills, model-instructions, emotional, users, time)
 * Others: identity one-liner + core facts + skills + time
 */
export function buildSoulBundle(type: SessionType, memory?: MemoryManager | null): string | null {
  const parts: string[] = [];

  if (type === "A") {
    // Full Main bundle
    let bundle: { soul: string; profile: string; notes: string; memoryTools: string; coreFacts: string } | null = null;
    try { bundle = memory?.getSessionBundle() ?? null; } catch (err) { logAndSwallow(TAG, "op", err); }

    const soul = bundle?.soul || readOr(join(HOST_CORE_DIR, "SOUL.md"));
    const memoryTools = bundle?.profile || readOr(join(HOST_CORE_DIR, "user_profile.md"));
    const userProfile = bundle?.notes || readOr(join(HOST_CORE_DIR, "agent_notes.md"));
    const agentNotes = bundle?.memoryTools || readOr(join(HOST_CORE_DIR, "TOOLS.md"));
    const coreFacts = bundle?.coreFacts || readOr(join(HOST_CORE_DIR, "core_facts.md"));

    if (soul) parts.push(soul);
    if (memoryTools) parts.push(memoryTools);
    if (userProfile) parts.push(userProfile);
    if (agentNotes) parts.push(agentNotes);
    if (coreFacts) parts.push(coreFacts);

    const skillsCatalog = readOr(join(HOST_CORE_DIR, "skills_catalog.md"));
    if (skillsCatalog) parts.push(skillsCatalog);

    const modelInstructions = buildModelInstructions();
    if (modelInstructions) parts.push(modelInstructions);

    try {
      const arcs = memory?.getEmotionalArcs() ?? [];
      if (arcs.length > 0) {
        const ARC_LABELS: Record<string, string> = { "↑": "user sentiment improving", "↓": "user sentiment worsening — be careful", "↕": "volatile — user feelings fluctuate", "→": "stable" };
        const lines = arcs.map((a: { topic: string; arc: string }) => `- ${a.topic}: ${a.arc} (${ARC_LABELS[a.arc] ?? "unknown"})`);
        parts.push(`[EMOTIONAL CONTEXT]\n${lines.join("\n")}`);
      }
    } catch (err) { logAndSwallow(TAG, "op", err); }

    try {
      const registry = loadUsers();
      if (registry.users.length > 0) parts.push(buildUsersBlock(registry));
    } catch (err) { logAndSwallow(TAG, "op", err); }
  } else {
    // Lightweight bundle: identity + core facts + skills
    const identity = TYPE_IDENTITY[type];
    if (identity) parts.push(identity);

    const coreFacts = readOr(join(HOST_CORE_DIR, "core_facts.md"));
    if (coreFacts) parts.push(coreFacts);

    const skillsCatalog = readOr(join(HOST_CORE_DIR, "skills_catalog.md"));
    if (skillsCatalog) parts.push(skillsCatalog);
  }

  parts.push(buildCurrentTime());

  if (parts.length === 0) {
    logWarn(TAG, "No bundle parts generated");
    return null;
  }

  logInfo(TAG, `Bundle [${type}]: ${parts.length} parts`);
  logDebug(TAG, `Parts: ${parts.map((p, i) => `${i}:${p.length}ch`).join(", ")}`);
  return parts.join("\n\n---\n\n");
}
