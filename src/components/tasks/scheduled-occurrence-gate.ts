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
import { readTaskCatalog } from "./task-store.js";
import { readTaskRunById } from "./task-state-store.js";

export interface ScheduledOccurrence {
  entry: import("./task-types.js").ScheduledTask;
  run: import("./task-state-store.js").ActiveTaskRun;
}

export type ScheduledOccurrenceState =
  | "active"
  | "terminal"
  | "unavailable"
  | "not_scheduled";

export type ScheduledOccurrenceInspection =
  | { readonly state: "active"; readonly occurrence: ScheduledOccurrence }
  | { readonly state: "terminal" }
  | { readonly state: "unavailable"; readonly reason: "run_unavailable" | "definition_unavailable" | "definition_missing" }
  | { readonly state: "not_scheduled" };

/** Scheduled-root identity — durable facts only (no supervision lookup). */
export function isScheduledRootIdentity(card: KanbanCard): boolean {
  if (card.type !== "O" || card.parent_id !== null) return false;
  if (card.source !== "task" || !card.source_id || card.source_id.length === 0) return false;
  return true;
}

export function inspectScheduledOccurrence(card: KanbanCard): ScheduledOccurrenceInspection {
  if (!isScheduledRootIdentity(card)) return { state: "not_scheduled" };
  const runLookup = readTaskRunById(card.source_id!);
  if (runLookup.kind === "missing" || runLookup.kind === "terminal") return { state: "terminal" };
  if (runLookup.kind === "unavailable") return { state: "unavailable", reason: "run_unavailable" };
  // active
  if (runLookup.run.cardId !== card.id) return { state: "terminal" };
  if (runLookup.run.terminalRequest) return { state: "terminal" };
  const catalog = readTaskCatalog();
  if (catalog.kind === "unavailable") return { state: "unavailable", reason: "definition_unavailable" };
  const entry = catalog.entries.find(e => e.id === runLookup.taskId);
  if (entry) return { state: "active", occurrence: { entry, run: runLookup.run } };
  return { state: "unavailable", reason: "definition_missing" };
}

/**
 * Find the live (unfinished) task run this card was created for, with its
 * owning task definition. Undefined means no unfinished matching run exists —
 * the occurrence is missing or already settled.
 */
export function findActiveScheduledOccurrence(card: KanbanCard): ScheduledOccurrence | undefined {
  const inspection = inspectScheduledOccurrence(card);
  if (inspection.state === "active") return inspection.occurrence;
  return undefined;
}

/**
 * The four-state admission decision consumed by both claim paths.
 *
 * - "active":         live matching unfinished run without a terminal request and with a verifiable definition.
 * - "terminal":       scheduled-root identity whose occurrence is missing,
 *                     settled, mismatched, or carries a durable terminal request.
 * - "unavailable":    live run whose definition cannot be verified (db failure or catalog unavailable/missing).
 * - "not_scheduled":  not a scheduled root — the gate does not apply.
 */
export function scheduledOccurrenceState(card: KanbanCard): ScheduledOccurrenceState {
  return inspectScheduledOccurrence(card).state;
}
