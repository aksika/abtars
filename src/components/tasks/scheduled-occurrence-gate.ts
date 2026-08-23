/**
 * scheduled-occurrence-gate.ts — #1707: the single fail-closed boundary that
 * answers "does this project card still belong to a live scheduled task
 * occurrence?".
 *
 * A terminal authority is absolute: a failed, cancelled, expired, or missing
 * `task_runs` occurrence must never be restarted by the reconciler or by a
 * coordinator claim. Both layers consume this module so they cannot drift.
 */

import type { KanbanCard } from "./kanban-board.js";
import { readEntries } from "./task-store.js";
import { readState } from "./task-state-store.js";
import { logWarn } from "../logger.js";

export interface ScheduledOccurrence {
  entry: import("./task-types.js").ScheduledTask;
  run: import("./task-state-store.js").ActiveTaskRun;
}

/** Scheduled-root identity — durable facts only (no supervision lookup). */
export function isScheduledRootIdentity(card: KanbanCard): boolean {
  if (card.type !== "O" || card.parent_id !== null) return false;
  if (card.source !== "task" || !card.source_id || card.source_id.length === 0) return false;
  return true;
}

/**
 * Find the live (unfinished) task run this card was created for, with its
 * owning task definition. Undefined means no unfinished matching run exists —
 * the occurrence is missing or already settled.
 */
export function findActiveScheduledOccurrence(card: KanbanCard): ScheduledOccurrence | undefined {
  try {
    for (const entry of readEntries()) {
      const state = readState(entry.id);
      const run = state?.activeRun;
      if (run && run.runId === card.source_id && run.cardId === card.id) return { entry, run };
    }
  } catch (err) {
    // Fail closed on read errors too: an unreadable catalog must never admit
    // a claim against an unverifiable occurrence.
    logWarn("occurrence-gate", `occurrence lookup failed for card ${card.id}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  return undefined;
}

/**
 * The tri-state admission decision consumed by both claim paths.
 *
 * - "active":         live matching unfinished run without a terminal request.
 * - "terminal":       scheduled-root identity whose occurrence is missing,
 *                     settled, or carries a durable terminal request.
 * - "not_scheduled":  not a scheduled root — the gate does not apply.
 */
export function scheduledOccurrenceState(card: KanbanCard): "active" | "terminal" | "not_scheduled" {
  if (!isScheduledRootIdentity(card)) return "not_scheduled";
  const occurrence = findActiveScheduledOccurrence(card);
  if (!occurrence || occurrence.run.terminalRequest) return "terminal";
  return "active";
}
