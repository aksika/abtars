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
import type { SessionType } from "./spin-types.js";

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
  S: null, // reserved — not actively used
  P: "I am responding to a peer agent request. Be precise and technical.",
  O: null, // Orchestrator — dedicated prompt loaded separately
  W: null, // Worker — dedicated prompt file (core/prompts/worker.md)
  D: null, // Dreamy — sleep prompt loaded separately
  H: "I am the Healer. I diagnose and fix system failures. If unfixable, state: Requires human intervention.",
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
    if (!bundle?.soul) {
      logWarn(TAG, "SOUL bundle unavailable — abmind not configured or getSessionBundle() failed");
      return "[ERROR] SOUL bundle missing. Tell the user: memory system is not configured. Run /doctor or check abmind installation.";
    }

    const soul = bundle?.soul ?? "";
    const userProfile = bundle?.profile ?? "";
    const agentNotes = bundle?.notes ?? "";
    const memoryTools = bundle?.memoryTools ?? "";
    const coreFacts = bundle?.coreFacts ?? "";

    if (soul) parts.push(soul);
    if (memoryTools) parts.push(memoryTools);
    if (userProfile) parts.push(userProfile);
    if (agentNotes) parts.push(agentNotes);
    if (coreFacts) parts.push(coreFacts);

    const skillsCatalog = readOr(join(abtarsHome(), "skills", "skills_catalog.md"));
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
  } else if (type === "W") {
    // Worker: dedicated prompt file only
    const workerPrompt = readOr(join(HOST_CORE_DIR, "prompts", "worker.md"));
    if (workerPrompt) parts.push(workerPrompt);
  } else if (type === "O") {
    // Orc: dedicated prompt file only
    const orcPrompt = readOr(join(HOST_CORE_DIR, "prompts", "orc.md"));
    if (orcPrompt) parts.push(orcPrompt);
  } else {
    // Lightweight bundle: identity + skills
    const identity = TYPE_IDENTITY[type];
    if (identity) parts.push(identity);

    const skillsCatalog = readOr(join(abtarsHome(), "skills", "skills_catalog.md"));
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
