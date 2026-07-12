/**
 * orc-tools.ts — Orc-specific tools for spawning/managing workers (#1005).
 *
 * Module-scoped activeOrcCardId — set by executeOrc before prompt, cleared in finally.
 * Tools always registered; return error if no active Orc project.
 */

import type { ToolDefinition } from "./tool-registry.js";
import { logInfo } from "../logger.js";

const TAG = "orc-tools";

let _activeOrcCardId: number | null = null;

export function setActiveOrcCard(id: number | null): void {
  _activeOrcCardId = id;
}

export function getActiveOrcCard(): number | null {
  return _activeOrcCardId;
}

/**
 * #1301 — true when the Orc is currently processing a peer-originated card.
 *
 * Relay tools (peer_session/peer_wakeup/peer_delegate) call this to refuse: a
 * peer must never be able to make us call a THIRD peer under our identity
 * (relay/identity-confusion). Keys off the active card's `source` — not the
 * session — so it stays correct for the shared singleton Orc (owner-initiated
 * delegation on an owner card is still allowed).
 */
export async function isActiveCardPeerSourced(): Promise<boolean> {
  if (_activeOrcCardId == null) return false;
  try {
    const { kanbanGetCard } = await import("../tasks/kanban-board.js");
    return kanbanGetCard(_activeOrcCardId)?.source === "peer";
  } catch {
    return false;
  }
}

// ── spawn_worker ─────────────────────────────────────────────────────────────

function parseJsonArray(raw: string | undefined): unknown[] {
  if (!raw) return [];
  try { return JSON.parse(raw) as unknown[]; } catch { return []; }
}

const spawnWorkerTool: ToolDefinition = {
  name: "spawn_worker",
  description: "Spawn a worker to execute a task in parallel. Workers run independently and report results. For supervised dispatch (Agent Swarm), provide structured criteria, artifacts, and checks.",
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string", description: "What the worker should accomplish (detailed instruction)" },
      title: { type: "string", description: "Short label for the worker card (optional)" },
      priority: { type: "string", description: "CRITICAL | HIGH | MEDIUM | LOW", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
      criteria: { type: "string", description: "JSON array of {id, description} acceptance criteria (supervised)" },
      expected_artifacts: { type: "string", description: "JSON array of {id, kind, ref, required, criterion_ids} expected artifacts (supervised)" },
      verification_commands: { type: "string", description: "JSON array of {id, argv, cwd, timeout_ms, criterion_ids} verification commands (supervised)" },
      required_capabilities: { type: "string", description: "JSON array of required capability strings (supervised)" },
    },
    required: ["goal"],
  },
  async execute(args: Record<string, string>): Promise<string> {
    if (!_activeOrcCardId) return "[err] No active Orc project. spawn_worker only works during orchestration.";
    const goal = args.goal;
    if (!goal) return "[err] goal is required";
    const { spin } = await import("../spin.js");
    const criteriaRaw = parseJsonArray(args.criteria);
    const artifactsRaw = parseJsonArray(args.expected_artifacts);
    const commandsRaw = parseJsonArray(args.verification_commands);
    const capsRaw = parseJsonArray(args.required_capabilities) as string[];
    const hasStructuredData = criteriaRaw.length > 0 || artifactsRaw.length > 0 || commandsRaw.length > 0;
    const contract = hasStructuredData ? {
      schema_version: 1 as const,
      id: "",
      digest: "",
      goal,
      criteria: criteriaRaw as Array<{ id: string; description: string }>,
      expected_artifacts: artifactsRaw as Array<{ id: string; kind: "file" | "directory" | "report" | "logical"; ref: string; required: boolean; criterion_ids: string[] }>,
      verification_commands: commandsRaw as Array<{ id: string; argv: string[]; cwd?: string; timeout_ms: number; criterion_ids: string[] }>,
      required_capabilities: capsRaw,
      limits: {},
      provenance: { root_card_id: 0, card_id: 0, authored_by: "orc", created_at: "" },
    } : undefined;
    const cardId = spin.spawnChild(_activeOrcCardId, {
      goal,
      title: args.title || goal.slice(0, 40),
      source: "agent",
      priority: args.priority as any,
      contract,
    });
    logInfo(TAG, `spawn_worker card:${cardId} parent:${_activeOrcCardId} — ${(args.title || goal).slice(0, 60)}${hasStructuredData ? " [supervised]" : ""}`);
    return `+ Worker card #${cardId} created: "${args.title || goal.slice(0, 40)}"${hasStructuredData ? " [supervised]" : ""}`;
  },
};

// ── check_workers ────────────────────────────────────────────────────────────

const checkWorkersTool: ToolDefinition = {
  name: "check_workers",
  description: "Check status of all workers on the current project. Returns their status and results.",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(): Promise<string> {
    if (!_activeOrcCardId) return "[err] No active Orc project.";
    const { kanbanGetChildren } = await import("../tasks/kanban-board.js");
    const children = kanbanGetChildren(_activeOrcCardId);
    if (children.length === 0) return "No workers spawned yet.";
    const lines = children.map(c => {
      const icon = c.status === "done" ? "*" : c.status === "running" ? "~" : c.status === "failed" ? "x" : "+";
      const result = c.result_summary ? ` — ${c.result_summary.slice(0, 100)}` : "";
      const tokens = c.tokens_used ? ` (${c.tokens_used} tok)` : "";
      const source = c.type === "remote" ? (() => { try { return ` [${JSON.parse(c.notes ?? "{}").peer}]`; } catch { return ""; } })() : "";
      return `${icon} #${c.id} ${c.title || "(untitled)"} (${c.status})${tokens}${source}${result}`;
    });
    return `Workers (${children.length}):\n${lines.join("\n")}`;
  },
};

// ── cancel_worker ────────────────────────────────────────────────────────────

const cancelWorkerTool: ToolDefinition = {
  name: "cancel_worker",
  description: "Cancel a running or queued worker. Use when a task is no longer needed (e.g., another worker found the answer first).",
  parameters: {
    type: "object",
    properties: {
      card_id: { type: "string", description: "The card ID of the worker to cancel" },
    },
    required: ["card_id"],
  },
  async execute(args: Record<string, string>): Promise<string> {
    if (!_activeOrcCardId) return "[err] No active Orc project.";
    const cardId = parseInt(args.card_id ?? "", 10);
    if (isNaN(cardId)) return "[err] Invalid card_id.";
    const { kanbanGetCard, kanbanFail } = await import("../tasks/kanban-board.js");
    const card = kanbanGetCard(cardId);
    if (!card) return `[err] Card #${cardId} not found.`;
    if (card.parent_id !== _activeOrcCardId) return `[err] Card #${cardId} is not a child of this project.`;
    if (card.status === "done" || card.status === "delivered") return `Card #${cardId} already completed.`;
    kanbanFail(cardId, "cancelled by Orc");
    logInfo(TAG, `cancel_worker card:${cardId} (parent:${_activeOrcCardId})`);
    return `x Worker #${cardId} cancelled.`;
  },
};

// ── Export ────────────────────────────────────────────────────────────────────

export function getOrcTools(): ToolDefinition[] {
  return [spawnWorkerTool, checkWorkersTool, cancelWorkerTool];
}
