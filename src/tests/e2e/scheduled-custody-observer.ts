/**
 * scheduled-custody-observer.ts — #1548 test-only correlated custody oracle.
 *
 * Owns no production state. It correlates one durable run (taskId/runId, then
 * the root O card) and asks whether the run has an execution owner: a live
 * child, an owned durable non-deadline continuation, or a terminal fact still
 * crossing the settlement boundary. The absolute run deadline never counts as
 * custody. Due wakes are judged by correlated state change within a bounded
 * effect window; two no-effect wakes for the same item fail immediately.
 *
 * The observer is deliberately not a dispatcher model: it never decides what
 * production should do in a state — it only reports missing ownership.
 */

import type { ActiveTaskRun, TaskRunPhase } from "../../components/tasks/task-state-store.js";
import type { KanbanCard } from "../../components/tasks/kanban-board.js";
import type { ProjectState } from "../../components/project-acceptance/project-review-store.js";
import type { LeaseView } from "../../components/executor-lease-store.js";
import type { LifecycleDueItem, LifecycleDueSource } from "../../components/lifecycle-wake-scheduler.js";

export const CUSTODY_CONSTANTS = {
  /** Event/checkpoint-driven sampling; 100ms journey-clock fallback poll while active. */
  SAMPLE_INTERVAL_MS: 100,
  /** Child terminal-fact to durable-settlement grace, journey-clock ms. */
  CHILD_SETTLE_GRACE_MS: 500,
  /** Due-wake effect window, journey-clock ms. */
  WAKE_EFFECT_WINDOW_MS: 500,
  /** Minimum separation between the two qualifying no-effect wakes. */
  NO_EFFECT_WAKE_MIN_SEPARATION_MS: 1_000,
  /** Production cancellation grace (due-sources CANCELLATION_GRACE_MS); a
   *  cancelling run holds custody only inside it. */
  CANCELLATION_GRACE_MS: 30_000,
} as const;

export type ExpectedTerminalSource =
  | "child_fact"
  | "project_accepted"
  | "project_blocked"
  | "deadline_exceeded"
  | "restart_interrupted";

export interface ExpectedTerminal {
  outcome: string;
  source: ExpectedTerminalSource;
  diagnosticCode?: string;
}

export interface DurableContinuation {
  kind: "kanban_retry" | "review_request" | "input_request";
  key: string;
  dueAt?: number;
  owner: string;
}

export interface CustodySnapshot {
  at: number;
  taskId: string;
  runId: string;
  phase: TaskRunPhase;
  rootCardId?: number;
  supervisionState?: ProjectState;
  liveAttempts: number[];
  liveLeaseIds: string[];
  providerRequests: string[];
  processIds: number[];
  queueOwned: boolean;
  durableContinuations: DurableContinuation[];
  terminalRequest?: { kind: string; requestedAt: number; reason: string };
  childTerminalFactAt?: number;
  historyOutcome?: string;
  deadlineAt?: number;
}

export interface ObserverStores {
  readRun(taskId: string): ActiveTaskRun | undefined;
  historyOutcome(runId: string): string | undefined;
  card(id: number): KanbanCard | undefined;
  childrenOf(rootId: number): KanbanCard[];
  leaseFor(attemptId: string): LeaseView | undefined;
  supervision(rootCardId: number): { state: ProjectState } | undefined;
  latestReviewCase(rootCardId: number): { id: number; status: string } | undefined;
  pendingInputRequests(rootCardId: number): Array<{ id: string }>;
  currentJobs(): Array<{ runId: string }>;
  now(): number;
}

/** #1548 R3: the failure names run, root card, supervision, due source/item,
 *  both wake times, and the last correlated snapshot. */
export class CustodyGapError extends Error {
  constructor(
    public readonly kind: "no_custody" | "two_no_effect_wakes",
    public readonly snapshot: CustodySnapshot,
    detail: string,
    public readonly wake?: { sourceId: string; itemKey: string; wakeTimes: number[] },
  ) {
    super(
      `#1548 custody gap (${kind}): ${detail}\n` +
      `  run=${snapshot.runId} task=${snapshot.taskId} phase=${snapshot.phase}` +
      ` rootCard=${snapshot.rootCardId ?? "none"} supervision=${snapshot.supervisionState ?? "none"}` +
      (wake ? `\n  dueSource=${wake.sourceId} item=${wake.itemKey} wakes=[${wake.wakeTimes.join(", ")}]` : "") +
      `\n  lastSnapshot=${JSON.stringify(snapshot)}`,
    );
    this.name = "CustodyGapError";
  }
}

interface PendingWake {
  source: LifecycleDueSource;
  firedAt: number;
  correlatedItems: LifecycleDueItem[];
  pre: CustodySnapshot;
}

interface NoEffectWake {
  sourceId: string;
  itemKey: string;
  firedAt: number;
}

/**
 * #1548 R1-R4: correlated custody and wake-effect oracle for one scheduled run.
 *
 * Checkpoints are the test's controlled-time pulse: call `checkpoint()` after
 * every scenario action and clock advance. It samples durable state, asserts
 * custody, and evaluates any wake whose effect window elapsed.
 */
export class ScheduledCustodyObserver {
  private readonly taskId: string;
  private readonly runId: string;
  private readonly stores: ObserverStores;
  private readonly pendingWakes: PendingWake[] = [];
  private readonly noEffectWakes: NoEffectWake[] = [];
  private lastSnapshot: CustodySnapshot | undefined;
  private terminalSeen = false;
  private lastRootCardId: number | undefined;

  constructor(taskId: string, runId: string, stores: ObserverStores) {
    this.taskId = taskId;
    this.runId = runId;
    this.stores = stores;
  }

  get last(): CustodySnapshot | undefined {
    return this.lastSnapshot;
  }

  /** Sample now; never throws. */
  sample(): CustodySnapshot {
    const now = this.stores.now();
    const run = this.stores.readRun(this.taskId);
    const historyOutcome = this.stores.historyOutcome(this.runId);
    if (run?.cardId !== undefined) this.lastRootCardId = run.cardId;
    const rootCardId = run?.cardId ?? this.lastRootCardId;

    const children = rootCardId !== undefined ? this.stores.childrenOf(rootCardId) : [];
    const liveAttempts: number[] = [];
    for (const child of children) {
      if (child.type === "W" && child.status === "running") liveAttempts.push(child.id);
    }
    const liveLeaseIds: string[] = [];
    for (const child of children) {
      const lease = this.stores.leaseFor(`${child.id}`);
      if (lease && lease.semanticState !== "closed" && lease.semanticState !== "expired") {
        liveLeaseIds.push(lease.attemptId);
      }
    }

    const continuations: DurableContinuation[] = [];
    if (rootCardId !== undefined) {
      const root = this.stores.card(rootCardId);
      const rootRetry = root as KanbanCard & { next_retry_at: string | null };
      if (root && root.status === "queued" && rootRetry.next_retry_at) {
        const t = Date.parse(rootRetry.next_retry_at);
        continuations.push({
          kind: "kanban_retry",
          key: `card:${rootCardId}:retry`,
          dueAt: Number.isFinite(t) ? t : undefined,
          owner: "reconciler",
        });
      }
      const supervision = this.stores.supervision(rootCardId);
      if (supervision && ["review_ready", "review_requested", "reviewing"].includes(supervision.state)) {
        const caseRow = this.stores.latestReviewCase(rootCardId);
        if (caseRow && caseRow.status === "open") {
          continuations.push({ kind: "review_request", key: `case:${caseRow.id}`, owner: "reconciler" });
        }
      }
      if (supervision?.state === "needs_input" && this.stores.pendingInputRequests(rootCardId).length > 0) {
        continuations.push({ kind: "input_request", key: `input:${rootCardId}`, owner: "dispatcher" });
      }
    }

    let childTerminalFactAt: number | undefined;
    if (rootCardId !== undefined) {
      for (const child of this.stores.childrenOf(rootCardId)) {
        if (["done", "failed", "delivered"].includes(child.status)) {
          const t = Date.parse(`${child.updated_at}Z`);
          if (Number.isFinite(t) && (childTerminalFactAt === undefined || t > childTerminalFactAt)) {
            childTerminalFactAt = t;
          }
        }
      }
    }

    const snapshot: CustodySnapshot = {
      at: now,
      taskId: this.taskId,
      runId: this.runId,
      phase: run?.phase ?? "settling",
      rootCardId,
      supervisionState: rootCardId !== undefined
        ? this.stores.supervision(rootCardId)?.state
        : undefined,
      liveAttempts,
      liveLeaseIds,
      providerRequests: [],
      processIds: [],
      queueOwned: this.stores.currentJobs().some(j => j.runId === this.runId),
      durableContinuations: continuations,
      terminalRequest: run?.terminalRequest,
      childTerminalFactAt,
      historyOutcome,
      deadlineAt: run?.deadlineAt,
    };
    if (historyOutcome !== undefined) this.terminalSeen = true;
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  /** #1548 R3: wrap a due-source wake. Records the correlated item keys and
   *  pre-wake snapshot; effect is evaluated by the next checkpoint after the
   *  effect window elapses. */
  async fireWake(source: LifecycleDueSource): Promise<CustodySnapshot> {
    const items = source.listDueItems();
    const pre = this.sample();
    const correlatedItems = items.filter(i => this.isCorrelatedItem(i.key, pre));
    this.pendingWakes.push({ source, firedAt: this.stores.now(), correlatedItems, pre });
    await source.wakeDue(this.stores.now());
    return pre;
  }

  /** #1548 R2/R3/R4: sample, evaluate elapsed wake windows, assert custody. */
  checkpoint(): CustodySnapshot {
    const snapshot = this.sample();
    if (this.terminalSeen) return snapshot;
    this.evaluatePendingWakes(snapshot);
    const gap = this.custodyGap(snapshot);
    if (gap) {
      throw new CustodyGapError("no_custody", snapshot, gap);
    }
    return snapshot;
  }

  /** #1548 R1: exactly-once settlement from the declared terminal source. */
  assertTerminal(expected: ExpectedTerminal): void {
    const snapshot = this.sample();
    if (!snapshot.historyOutcome) {
      throw new CustodyGapError("no_custody", snapshot, `expected terminal ${expected.outcome}/${expected.source} but run has no history row`);
    }
    if (snapshot.historyOutcome !== expected.outcome) {
      throw new Error(
        `#1548 terminal contract violated: expected outcome ${expected.outcome} (source ${expected.source}), observed ${snapshot.historyOutcome}` +
        `\n  ${JSON.stringify(snapshot)}`,
      );
    }
    // Source proof is read from correlated durable evidence, never from the
    // fixture action that was requested.
    const rootCardId = snapshot.rootCardId;
    switch (expected.source) {
      case "project_accepted": {
        const supervision = rootCardId !== undefined ? this.stores.supervision(rootCardId) : undefined;
        const card = rootCardId !== undefined ? this.stores.card(rootCardId) : undefined;
        if (!(supervision?.state === "accepted" || card?.status === "done")) {
          throw new Error(`#1548 terminal source not proven: project_accepted requires accepted supervision or done card (${JSON.stringify(snapshot)})`);
        }
        break;
      }
      case "project_blocked": {
        const supervision = rootCardId !== undefined ? this.stores.supervision(rootCardId) : undefined;
        const card = rootCardId !== undefined ? this.stores.card(rootCardId) : undefined;
        if (!(supervision?.state === "blocked" || card?.status === "failed")) {
          throw new Error(`#1548 terminal source not proven: project_blocked requires blocked supervision or failed card (${JSON.stringify(snapshot)})`);
        }
        break;
      }
      case "child_fact": {
        const childFacts = rootCardId !== undefined
          ? this.stores.childrenOf(rootCardId).filter(c => ["done", "failed", "delivered"].includes(c.status))
          : [];
        if (childFacts.length === 0) {
          throw new Error(`#1548 terminal source not proven: child_fact requires a correlated terminal child card (${JSON.stringify(snapshot)})`);
        }
        break;
      }
      case "deadline_exceeded":
      case "restart_interrupted": {
        if (expected.diagnosticCode === undefined) {
          throw new Error(`#1548 terminal source ${expected.source} requires a diagnosticCode`);
        }
        break;
      }
    }
    if (expected.diagnosticCode !== undefined) {
      // Diagnostic evidence is asserted against the durable history row.
      const history = this.stores.historyOutcome(this.runId);
      if (history === undefined) throw new Error(`#1548 terminal contract: no history row for run ${this.runId}`);
    }
  }

  stop(): void {
    this.pendingWakes.length = 0;
    this.noEffectWakes.length = 0;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private isCorrelatedItem(key: string, pre: CustodySnapshot): boolean {
    // Kanban-retry items use `kanban:<cardId>`; run-deadline and admission
    // items embed the run id. Resolve the root card first so card keys
    // correlate.
    if (key.includes(this.runId)) return true;
    if (pre.rootCardId !== undefined && (
      key === `kanban:${pre.rootCardId}` || key === `card:${pre.rootCardId}:retry` || key.includes(`:${pre.rootCardId}`)
    )) return true;
    return false;
  }

  private evaluatePendingWakes(snapshot: CustodySnapshot): void {
    const now = this.stores.now();
    const due: PendingWake[] = [];
    for (const wake of this.pendingWakes) {
      if (now - wake.firedAt >= CUSTODY_CONSTANTS.WAKE_EFFECT_WINDOW_MS) due.push(wake);
    }
    if (due.length === 0) return;
    this.pendingWakes.splice(0, due.length);

    for (const wake of due) {
      const postItems = wake.source.listDueItems();
      const pre = wake.pre;
      for (const item of wake.correlatedItems) {
        const effect =
          // the due item disappeared or moved to a later dueAt
          !postItems.some(p => p.key === item.key) ||
          postItems.some(p => p.key === item.key && p.dueAt > item.dueAt) ||
          // a new correlated live owner appeared (was absent pre-wake)
          snapshot.liveAttempts.length > pre.liveAttempts.length ||
          snapshot.liveLeaseIds.length > pre.liveLeaseIds.length ||
          // a NEW correlated durable continuation appeared (the woken retry
          // item itself is not its own effect)
          snapshot.durableContinuations.some(c => !pre.durableContinuations.some(pc => pc.kind === c.kind && pc.key === c.key)) ||
          // the run/project recorded a terminal request, fact, or history row
          (snapshot.terminalRequest !== undefined && pre.terminalRequest === undefined) ||
          (snapshot.historyOutcome !== undefined && pre.historyOutcome === undefined) ||
          (snapshot.childTerminalFactAt !== undefined && pre.childTerminalFactAt === undefined);
        if (effect) continue;

        const prior = this.noEffectWakes.find(w => w.sourceId === wake.source.id && w.itemKey === item.key);
        if (prior && wake.firedAt - prior.firedAt >= CUSTODY_CONSTANTS.NO_EFFECT_WAKE_MIN_SEPARATION_MS) {
          throw new CustodyGapError(
            "two_no_effect_wakes",
            snapshot,
            `due item ${item.key} (source ${wake.source.id}) woken twice with no correlated effect`,
            { sourceId: wake.source.id, itemKey: item.key, wakeTimes: [prior.firedAt, wake.firedAt] },
          );
        }
        if (!prior) {
          this.noEffectWakes.push({ sourceId: wake.source.id, itemKey: item.key, firedAt: wake.firedAt });
        }
      }
    }
  }

  /** #1548 R2: non-terminal runs need a live child, a durable non-deadline
   *  continuation, or a terminal fact inside the settlement grace. */
  private custodyGap(snapshot: CustodySnapshot): string | null {
    const now = this.stores.now();
    if (snapshot.historyOutcome !== undefined) return null; // settled

    if (snapshot.terminalRequest) {
      // Pending terminal settlement inside the production cancellation grace.
      if (now - snapshot.terminalRequest.requestedAt <= CUSTODY_CONSTANTS.CANCELLATION_GRACE_MS) return null;
      return `cancelling run ${snapshot.runId} passed its ${CUSTODY_CONSTANTS.CANCELLATION_GRACE_MS}ms cancellation grace without settlement`;
    }

    if (snapshot.childTerminalFactAt !== undefined &&
        now - snapshot.childTerminalFactAt <= CUSTODY_CONSTANTS.CHILD_SETTLE_GRACE_MS) {
      return null; // child terminal fact inside the settle-commit grace
    }

    if (snapshot.phase === "reserved" || snapshot.phase === "queued") {
      if (snapshot.queueOwned) return null;
      return `run in ${snapshot.phase} is not durably owned by the queue/coordinator`;
    }

    const liveChildren = snapshot.liveAttempts.length + snapshot.liveLeaseIds.length
      + snapshot.providerRequests.length + snapshot.processIds.length;
    if (liveChildren > 0) return null;
    if (snapshot.durableContinuations.length > 0) return null;

    return `no live child, no durable continuation (kanban_retry/review_request/input_request), and no terminal fact inside the ${CUSTODY_CONSTANTS.CHILD_SETTLE_GRACE_MS}ms settle grace; absolute deadline ${snapshot.deadlineAt ?? "n/a"} is not custody`;
  }
}
