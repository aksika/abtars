/**
 * kanban-tool.ts — Agent-facing tool for managing the kanban board.
 */

import type { ToolDefinition } from "./tool-registry.js";
import { kanbanEnqueue, kanbanUpdate, kanbanList, type KanbanCard } from "../tasks/kanban-board.js";
import { isValidSessionType } from "../spin-profiles.js";

function formatCard(c: KanbanCard): string {
  const icon = c.status === "delivered" ? "*" : c.status === "done" ? "*" : c.status === "running" ? "~" : c.status === "failed" ? "x" : "+";
  const due = c.due_at ? ` due:${c.due_at}` : "";
  const lbl = c.labels ? ` [${c.labels}]` : "";
  const deps = c.blocked_by ? ` <- #${c.blocked_by}` : "";
  const tokens = c.tokens_used ? ` ${c.tokens_used} tok` : "";
  const source = c.type === "remote" ? (() => { try { return ` [${JSON.parse(c.notes ?? "{}").peer}]`; } catch { return " [remote]"; } })() : "";
  return `${icon} #${c.id} ${c.title} (${c.priority}/${c.status})${tokens}${source}${due}${lbl}${deps}`;
}

async function execute(args: Record<string, string>): Promise<string> {
  const action = args.action;

  if (action === "create") {
    if (!args.title) return "[err] title required";
    // #1327: validate card.type at write time. kanban cards go into the
    // "queued" status by default, and drainQueued() dispatches them via
    // spin() using card.type as a SessionType. A ticket category like
    // "bug" or "feature" would crash the bridge on profile.agent access.
    // The schema documentation ("task, bug, feature, research, report,
    // etc.") is misleading — those are NOT valid for dispatchable cards.
    // Valid: any SessionType (A/B/C/T/P/S/O/W/D/H). Omit the field for
    // non-dispatchable tickets (e.g. a human-readable note for later).
    if (args.type && !isValidSessionType(args.type)) {
      return `[err] invalid card.type "${args.type}" (#1327): must be a SessionType (A/B/C/T/P/S/O/W/D/H) for dispatchable work, or omit the field for non-dispatchable tickets. Ticket categories (task/bug/feature/...) are not valid SessionTypes.`;
    }
    const id = kanbanEnqueue(args.title, args.source || "agent", undefined, {
      priority: args.priority,
      type: args.type,
      labels: args.labels,
      due_at: args.due_at,
      parent_id: args.parent_id ? parseInt(args.parent_id, 10) : undefined,
      notes: args.notes,
      blocked_by: args.blocked_by || undefined,
    });
    return `+ Card #${id} created: "${args.title}"${args.blocked_by ? ` (blocked_by: ${args.blocked_by})` : ""}`;
  }

  if (action === "update") {
    if (!args.id) return "[err] id required";
    const fields: Record<string, unknown> = {};
    for (const k of ["title", "status", "priority", "type", "labels", "due_at", "notes", "approval"] as const) {
      if (args[k]) fields[k] = args[k];
    }
    if (args.parent_id) fields.parent_id = parseInt(args.parent_id, 10);
    kanbanUpdate(parseInt(args.id, 10), fields as any);
    return `* Card #${args.id} updated`;
  }

  if (action === "list") {
    const cards = kanbanList(args.status || undefined);
    if (cards.length === 0) return "Board is empty";
    return `Kanban Board (${cards.length}):\n` + cards.map(formatCard).join("\n");
  }

  return `[err] Unknown action: ${action}. Use create | update | list`;
}

export const kanbanTool: ToolDefinition = {
  name: "kanban_manage",
  description: "Create, update, or list cards on the kanban board. Use for tracking work items, user requests, and task decomposition.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "create | update | list", enum: ["create", "update", "list"] },
      title: { type: "string", description: "Card title (required for create)" },
      id: { type: "string", description: "Card ID (required for update)" },
      source: { type: "string", description: "Who created: user | agent | cron | peer" },
      status: { type: "string", description: "New status (for update): queued | running | done | failed" },
      priority: { type: "string", description: "CRITICAL | HIGH | MEDIUM | LOW" },
      type: { type: "string", description: "Card type (task, bug, feature, research, report, etc.)" },
      labels: { type: "string", description: "Comma-separated tags" },
      due_at: { type: "string", description: "ISO deadline (e.g. 2026-06-08T12:00:00)" },
      parent_id: { type: "string", description: "Parent card ID for subtasks" },
      notes: { type: "string", description: "Additional context" },
      blocked_by: { type: "string", description: "Comma-separated card IDs this card depends on, or 'children' to wait for all child cards" },
      approval: { type: "string", description: "pending | approved | rejected" },
    },
    required: ["action"],
  },
  execute,
};
