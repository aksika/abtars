/**
 * reconciler.ts — K8s-inspired reconciliation loop for the Orc (#1364).
 *
 * Single scheduling authority: every supervised dispatch, retry, cancel, and
 * release decision originates here. Nerve/heartbeat events are only wakeups.
 * Reconciliation is keyed by card — independent cards run concurrently; one
 * card has at most one active pass (dirty-bit coalescing).
 */

import { nerve } from "./nerve.js";
import { spin } from "./spin.js";
import {
  kanbanFail, kanbanComplete, kanbanUpdate,
  kanbanGetCard, kanbanGetChildren, isUnblocked, cascadeFail, type KanbanCard,
} from "./tasks/kanban-board.js";
import { logInfo, logWarn } from "./logger.js";
import { WorkerSupervisionService } from "./worker-supervision-service.js";
import { ExecutorLeaseStore } from "./executor-lease-store.js";
import type { PiRunService } from "./pi-executor/pi-run-service.js";
import type { AttemptLifecycle } from "./worker-supervision-store.js";

const TAG = "reconciler";
const MAX_RETRIES = 3;
const MAX_WORKERS = 10;
const MAX_WALL_CLOCK_MS = 30 * 60 * 1000;

let _shutdownRequested = false;

export function setPiService(_service: PiRunService | null): void {
  // Pi service reference retained for future executor adapter use (#1364 Task 3)
}

export function requestShutdown(): void {
  _shutdownRequested = true;
}

// ── Keyed scheduler ──────────────────────────────────────────────────────────

interface CardReconcilerState {
  running: boolean;       // true while reconcileCard() is in flight
  dirty: boolean;         // true if a wakeup arrived during the pass
}

const _states = new Map<number, CardReconcilerState>();

function getState(cardId: number): CardReconcilerState {
  let s = _states.get(cardId);
  if (!s) { s = { running: false, dirty: false }; _states.set(cardId, s); }
  return s;
}

function wakeCard(cardId: number): void {
  const s = getState(cardId);
  if (s.running) { s.dirty = true; return; }
  s.running = true;
  s.dirty = false;
  // Use microtask to avoid deep stacks
  queueMicrotask(() => reconcileCard(cardId));
}

async function reconcileCard(cardId: number): Promise<void> {
  const s = getState(cardId);
  try {
    do {
      s.dirty = false;
      if (_shutdownRequested) return;
      deriveAction(cardId);
    } while (s.dirty);
  } finally {
    s.running = false;
  }
}

// ── Derive action ─────────────────────────────────────────────────────────────

function deriveAction(cardId: number): void {
  if (cardId <= 0) return;
  const card = kanbanGetCard(cardId);
  if (!card) return;

  // Project card (type "O") — reconcile children
  if (card.type === "O" && card.status === "running") {
    reconcileProject(cardId);
    return;
  }

  // Non-project card — check if supervised and reconcile individually
  reconcileChildCard(card);
}

function reconcileProject(projectId: number): void {
  const children = kanbanGetChildren(projectId);
  if (children.length === 0) return;

  const project = kanbanGetCard(projectId);
  if (!project) return;

  const now = Date.now();
  const projectStart = new Date(project.created_at + "Z").getTime();

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

  for (const child of children) {
    reconcileChildCard(child);
    totalRetries += child.delivery_attempts ?? 0;
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

function reconcileChildCard(card: KanbanCard): void {
  // #1364: Use supervision service for lifecycle-aware management
  const svc = new WorkerSupervisionService();
  const hasContract = svc.cardHasContract(card.id);
  const latestAttempt = hasContract ? getLatestAttemptInfo(card.id) : null;

  if (card.status === "queued") {
    if (!isUnblocked(card)) return;

    if (hasContract && latestAttempt) {
      // Supervised: claim if pending, otherwise skip
      if (latestAttempt.lifecycle === "pending") {
        logInfo(TAG, `Claiming supervised card ${card.id}`);
        spin.dispatch({ type: "W", goal: card.notes || card.title, source: "agent", cardId: card.id, parentCardId: card.parent_id ?? undefined });
      }
    } else {
      // Unsupervised: direct dispatch (legacy path)
      spin.dispatch({ type: "W", goal: card.notes || card.title, source: "agent", cardId: card.id, parentCardId: card.parent_id ?? undefined });
    }
    return;
  }

  if (card.status === "failed" && latestAttempt && latestAttempt.lifecycle !== "failed" && latestAttempt.lifecycle !== "cancelled") {
    const retries = card.delivery_attempts ?? 0;
    if (retries < MAX_RETRIES) {
      logInfo(TAG, `Retrying card ${card.id} (attempt ${retries + 1}/${MAX_RETRIES})`);
      kanbanUpdate(card.id, { status: "queued" });
      spin.dispatch({ type: "W", goal: card.notes || card.title, source: "agent", cardId: card.id, parentCardId: card.parent_id ?? undefined });
    } else {
      cascadeFail(card.id, kanbanGetChildren(card.parent_id ?? 0));
    }
    return;
  }

  if (card.status === "failed" && !hasContract) {
    const retries = card.delivery_attempts ?? 0;
    if (retries < MAX_RETRIES) {
      logInfo(TAG, `Retrying card ${card.id} (attempt ${retries + 1}/${MAX_RETRIES})`);
      kanbanUpdate(card.id, { status: "queued" });
      spin.dispatch({ type: "W", goal: card.notes || card.title, source: "agent", cardId: card.id, parentCardId: card.parent_id ?? undefined });
    } else {
      cascadeFail(card.id, kanbanGetChildren(card.parent_id ?? 0));
    }
    return;
  }

  // #1367: Lease-based stale evaluation for supervised cards
  if (hasContract && latestAttempt && !isTerminal(latestAttempt.lifecycle)) {
    evaluateLease(card);
    return;
  }

  // #1364: Cancel-requested supervised attempts — do NOT fail the card here;
  // the executor adapter will settle it. Reconciler only records policy intent.
  if (latestAttempt && latestAttempt.lifecycle === "cancel_requested") {
    return;
  }
}

function isTerminal(lc: AttemptLifecycle): boolean {
  return lc === "completed" || lc === "failed" || lc === "cancelled" || lc === "timed_out";
}

function evaluateLease(card: KanbanCard): void {
  try {
    const svc = new WorkerSupervisionService();
    const contract = svc.getContractForCard(card.id);
    if (!contract) return;
    const store = (svc as any)["store"] as import("./worker-supervision-store.js").WorkerSupervisionStore;
    const latestAttempt = store.getLatestAttempt(card.id);
    if (!latestAttempt) return;

    const leaseStore = new ExecutorLeaseStore();
    const snapshot = leaseStore.getSnapshot(latestAttempt.id);
    if (!snapshot) return;

    const now = Date.now();
    const livenessDeadline = new Date(snapshot.livenessDeadlineAt).getTime();
    const progressDeadline = new Date(snapshot.progressDeadlineAt).getTime();

    if (now > livenessDeadline || now > progressDeadline) {
      if (snapshot.evaluation === "healthy") {
        leaseStore.updateEvaluation(latestAttempt.id, "warning");
        logWarn(TAG, `Lease warning for card ${card.id}: attempt=${latestAttempt.id}`);
      } else if (snapshot.evaluation === "warning") {
        leaseStore.updateEvaluation(latestAttempt.id, "inspect_due");
        logWarn(TAG, `Inspect due for card ${card.id}`);
      } else if (snapshot.evaluation === "inspect_due") {
        logWarn(TAG, `Cancelling stale card ${card.id} via lease policy`);
        leaseStore.updateEvaluation(latestAttempt.id, "cancel_requested");
        store.requestCancel(latestAttempt.id, "lease_expired");
      }
    }
  } catch (err) {
    logWarn(TAG, `lease evaluation failed for card ${card.id}: ${err}`);
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

function getLatestAttemptInfo(cardId: number): { lifecycle: AttemptLifecycle } | null {
  try {
    const { WorkerSupervisionStore } = require("./worker-supervision-store.js") as typeof import("./worker-supervision-store.js");
    const store = new WorkerSupervisionStore();
    const latest = store.getLatestAttempt(cardId);
    if (!latest) return null;
    return { lifecycle: latest.lifecycle };
  } catch { return null; }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function requestReconcile(cardId: number): void {
  wakeCard(cardId);
}

export function requestReconcileForProject(cardId: number): void {
  // Wake the project card — it will reconcile children
  const card = kanbanGetCard(cardId);
  if (card?.parent_id) {
    wakeCard(card.parent_id);
  }
  wakeCard(cardId);
}

export function startReconciler(): void {
  nerve.on("card:queued", (cardId: number) => requestReconcileForProject(cardId));
  nerve.on("card:done", (cardId: number) => requestReconcileForProject(cardId));
  nerve.on("card:failed", (cardId: number) => requestReconcileForProject(cardId));
  logInfo(TAG, "Reconciler started");
}
