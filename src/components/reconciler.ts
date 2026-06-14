/**
 * reconciler.ts — K8s-inspired reconciliation loop for the Orc.
 *
 * Subscribes to Nerve events. On every state change, checks active projects
 * and fixes drift: dispatch queued, retry failed, kill stale, abort on limits.
 */

import { nerve } from "./nerve.js";
import { spin } from "./spin.js";
import {
  kanbanList, kanbanFail, kanbanComplete, kanbanUpdate,
  kanbanGetCard, kanbanGetChildren, isUnblocked, cascadeFail, type KanbanCard,
} from "./tasks/kanban-board.js";
import { logInfo, logWarn } from "./logger.js";

const TAG = "reconciler";
const MAX_RETRIES = 3;
const MAX_WORKERS = 10;
const MAX_WALL_CLOCK_MS = 30 * 60 * 1000;
const STALE_MS = 5 * 60 * 1000;

export function startReconciler(): void {
  nerve.on("card:done", reconcile);
  nerve.on("card:failed", reconcile);
  nerve.on("card:queued", reconcile);
  logInfo(TAG, "Reconciler started");
}

function reconcile(): void {
  const projects = kanbanList("running", "status")
    .filter(c => c.type === "O");

  for (const project of projects) {
    reconcileProject(project.id);
  }
}

function reconcileProject(projectId: number): void {
  const children = kanbanGetChildren(projectId);
  if (children.length === 0) return;

  const project = kanbanGetCard(projectId);
  if (!project) return;

  const now = Date.now();
  const projectStart = new Date(project.created_at).getTime();

  // Circuit breaker: wall-clock
  if (now - projectStart > MAX_WALL_CLOCK_MS) {
    abortProject(projectId, children, "wall-clock exceeded (30min)");
    return;
  }

  // Circuit breaker: token budget
  if (project.max_tokens && (project.tokens_used ?? 0) >= project.max_tokens) {
    abortProject(projectId, children, `budget exceeded (${project.tokens_used}/${project.max_tokens} tokens)`);
    return;
  }

  // Circuit breaker: too many workers
  if (children.length > MAX_WORKERS) {
    abortProject(projectId, children, `too many workers (${children.length})`);
    return;
  }

  let totalRetries = 0;

  for (const card of children) {
    const retries = card.delivery_attempts ?? 0; // reuse delivery_attempts as retry_count
    totalRetries += retries;

    if (card.status === "queued") {
      if (!isUnblocked(card)) continue;
      spin.dispatch({ type: "W", goal: card.notes || card.title, source: "agent", cardId: card.id, parentCardId: projectId });
    }

    if (card.status === "failed" && retries < MAX_RETRIES) {
      logInfo(TAG, `Retrying card ${card.id} (attempt ${retries + 1}/${MAX_RETRIES})`);
      kanbanUpdate(card.id, { status: "queued" });
      spin.dispatch({ type: "W", goal: card.notes || card.title, source: "agent", cardId: card.id, parentCardId: projectId });
    } else if (card.status === "failed" && retries >= MAX_RETRIES) {
      // Permanent failure — cascade to downstream cards
      cascadeFail(card.id, children);
    }

    if (card.status === "running" && isStale(card)) {
      logWarn(TAG, `Card ${card.id} stale (${STALE_MS / 1000}s no activity) — marking failed`);
      kanbanFail(card.id, "stale — no activity");
    }
  }

  // Circuit breaker: total retries
  if (totalRetries > MAX_RETRIES * 3) {
    abortProject(projectId, children, `too many total retries (${totalRetries})`);
    return;
  }

  // All done?
  if (children.every(c => c.status === "done" || c.status === "delivered")) {
    logInfo(TAG, `Project ${projectId}: all children done`);
    const summaries = children.map(c => c.result_summary).filter(Boolean).join("\n");
    kanbanComplete(projectId, null, summaries.slice(0, 500));
  }
}

function abortProject(projectId: number, children: KanbanCard[], reason: string): void {
  logWarn(TAG, `ABORT project ${projectId}: ${reason}`);
  for (const card of children) {
    if (card.status === "running" || card.status === "queued") {
      kanbanFail(card.id, `project aborted: ${reason}`);
    }
  }
  kanbanFail(projectId, reason);
}

function isStale(card: KanbanCard): boolean {
  const lastActivity = new Date(card.updated_at).getTime();
  return Date.now() - lastActivity > STALE_MS;
}

// Remote card polling moved to spin.tick() (#980)
