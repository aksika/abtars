/**
 * orc-tools.ts — Orc-specific tools for spawning/managing workers (#1005).
 *
 * Module-scoped activeOrcCardId — set by executeOrc before prompt, cleared in finally.
 * Tools always registered; return error if no active Orc project.
 */

import type { ToolDefinition } from "./tool-registry.js";
import { logInfo, logWarn } from "../logger.js";

const TAG = "orc-tools";

let _activeOrcCardId: number | null = null;

export function setActiveOrcCard(id: number | null): void {
  _activeOrcCardId = id;
}

export function getActiveOrcCard(): number | null {
  return _activeOrcCardId;
}

// ── spawn_worker ─────────────────────────────────────────────────────────────

const spawnWorkerTool: ToolDefinition = {
  name: "spawn_worker",
  description: "Spawn a worker to execute a task in parallel. Workers run independently and report results.",
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string", description: "What the worker should accomplish (detailed instruction)" },
      title: { type: "string", description: "Short label for the worker card (optional)" },
      priority: { type: "string", description: "CRITICAL | HIGH | MEDIUM | LOW", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
    },
    required: ["goal"],
  },
  async execute(args: Record<string, string>): Promise<string> {
    if (!_activeOrcCardId) return "[err] No active Orc project. spawn_worker only works during orchestration.";
    const { spin } = await import("../spin.js");
    const cardId = spin.spawnChild(_activeOrcCardId, {
      goal: args.goal,
      title: args.title || args.goal.slice(0, 40),
      source: "agent",
      priority: args.priority as any,
    });
    logInfo(TAG, `spawn_worker card:${cardId} parent:${_activeOrcCardId} — ${(args.title || args.goal).slice(0, 60)}`);
    return `+ Worker card #${cardId} created: "${args.title || args.goal.slice(0, 40)}"`;
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
      return `${icon} #${c.id} ${c.title || "(untitled)"} (${c.status})${result}`;
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
    const cardId = parseInt(args.card_id, 10);
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
