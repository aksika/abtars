import { logAndSwallow } from "../log-and-swallow.js";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logInfo, logWarn } from "../logger.js";
import { createRunId, reserveRun, readState } from "./task-state-store.js";
import { logTaskDebug } from "./task-log-ctx.js";
import type { ScheduledTask } from "./task-types.js";
import { isSystemEntry, isReminder, runCeilingMs } from "./task-types.js";
import { settleRunOnce, onRunTerminal } from "./task-run-settler.js";
import { makeTaskFailure } from "./task-failure.js";
import { ScheduledRunCoordinator, type RunLane } from "./scheduled-run-coordinator.js";
import type { ActiveTaskRun } from "./task-state-store.js";

const TAG = "cron-queue";
const LANES: RunLane[] = ["manual", "scheduled"];
// #1520: the queue snapshot lives under abtarsHome() and is diagnostic-only —
// it never replays work and is never a second source of truth.
const STATE_FILE = join(abtarsHome(), "state", "task-queue-state.json");

function getEntryMessage(entry: ScheduledTask): string {
  if (entry.kind === "reminder") return entry.text;
  if (entry.kind === "agent") return entry.prompt ?? entry.taskFile ?? "";
  if (entry.kind === "script") return entry.command;
  if (entry.kind === "system") return entry.action;
  return "";
}

interface PersistedJob {
  entryId: string;
  message: string;
  startedAt: number;
  type: string;
  runId?: string;
  priority?: string;
}

interface PersistedState {
  pid: number;
  currentJobs: Partial<Record<RunLane, PersistedJob | null>>;
  queues: Partial<Record<RunLane, PersistedJob[]>>;
}

function persistState(lanes: Record<RunLane, QueueLaneState>): void {
  try {
    const state: PersistedState = {
      pid: process.pid,
      currentJobs: Object.fromEntries(
        LANES.map(lane => [lane, lanes[lane].current ? jobToPersisted(lanes[lane].current!) : null]),
      ) as PersistedState["currentJobs"],
      queues: Object.fromEntries(
        LANES.map(lane => [lane, lanes[lane].pending.map(j => ({
          entryId: j.entry.id,
          message: getEntryMessage(j.entry),
          priority: j.entry.priority ?? "medium",
          runId: j.reservation?.runId,
        }))]),
      ) as PersistedState["queues"],
    };
    writeFileSync(STATE_FILE, JSON.stringify(state), "utf-8");
  } catch (err) { logAndSwallow("cron_queue", "op", err); }
}

function jobToPersisted(job: RunningJob): PersistedJob {
  return { entryId: job.entryId, message: job.message, startedAt: job.startedAt, type: job.type, runId: job.runId };
}

function loadStaleState(): PersistedState | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as PersistedState;
    if (raw.pid === process.pid) return null;
    return raw;
  } catch (err) { logAndSwallow(TAG, "loadStaleState", err); return null; }
}

export interface QueuedJob {
  entry: ScheduledTask;
  manual?: boolean;
  reservation?: ActiveTaskRun;
}

export interface RunningJob {
  entryId: string;
  message: string;
  pid: number;
  startedAt: number;
  type: "script" | "agent" | "system";
  manual?: boolean;
  /** #1517: the exact reserved run identity; ownership never infers from task ID. */
  runId: string;
  lane: RunLane;
}

interface QueueLaneState {
  current: RunningJob | null;
  pending: QueuedJob[];
  cap: 1;
}

function emptyLane(): QueueLaneState {
  return { current: null, pending: [], cap: 1 };
}

/**
 * #1539: two-lane admission queue. Lanes are cap-1 ordering structures only:
 * the ScheduledRunCoordinator owns execution, deadlines, cancellation, and
 * terminal normalization. Lane release is driven by the durable terminal
 * event, never by an adapter promise resolving.
 */
export class CronQueue {
  private readonly lanes: Record<RunLane, QueueLaneState> = {
    manual: emptyLane(),
    scheduled: emptyLane(),
  };
  private readonly coordinator: ScheduledRunCoordinator;
  private readonly terminalUnsub: () => void;

  constructor(coordinator: ScheduledRunCoordinator) {
    this.coordinator = coordinator;
    this.coordinator.setFollowUpEnqueue((entry) => this.enqueue(entry, false));
    this.terminalUnsub = onRunTerminal((_taskId, runId) => this.onRunTerminal(runId));
    // #1520: the stale snapshot is correlated against the authoritative
    // restart reconciliation (task state + history) for logging only. It
    // cannot create or replay work; both sides of the snapshot are cleared.
    const stale = loadStaleState();
    if (stale) {
      const currentJobs = stale.currentJobs ?? {};
      const queues = stale.queues ?? {};
      const currentCount = Object.values(currentJobs).filter(Boolean).length;
      const queueCount = Object.values(queues).reduce((n, q) => n + (q?.length ?? 0), 0);
      if (currentCount > 0) {
        logWarn(TAG, `Stale in-flight job(s) observed (${currentCount}) — recovery owned by task state reconciliation`);
      }
      if (queueCount > 0) {
        logWarn(TAG, `${queueCount} queued job(s) observed across restart — reconciliation decides; snapshot is diagnostic only`);
      }
      persistState(this.lanes);
    }
  }

  destroy(): void {
    this.terminalUnsub();
  }

  /** #1539: scheduled lane first for backward-compatible single-run display. */
  get currentJob(): RunningJob | null {
    return this.lanes.scheduled.current ?? this.lanes.manual.current;
  }

  get currentJobs(): RunningJob[] {
    return LANES.flatMap(lane => this.lanes[lane].current ? [this.lanes[lane].current!] : []);
  }

  get pending(): number {
    return LANES.reduce((n, lane) => n + this.lanes[lane].pending.length, 0);
  }

  /** Per-lane durable view: current + pending jobs with identity and trigger. */
  describe(): Array<{
    lane: RunLane;
    current: (RunningJob & {
      phase?: string;
      lastProgressAt?: number;
      deadlineAt?: number;
      terminalRequest?: { kind: "cancelled" | "deadline_exceeded"; requestedAt: number; reason: string };
      cardId?: number;
      sessionId?: string;
      executionId?: string;
    }) | null;
    pending: Array<{ entryId: string; runId?: string; manual?: boolean; priority?: string }>;
  }> {
    const runViews = new Map(this.coordinator.describe().map(v => [v.runId, v]));
    return LANES.map(lane => {
      const current = this.lanes[lane].current;
      const view = current ? runViews.get(current.runId) : undefined;
      return {
        lane,
        current: current ? {
          ...current,
          phase: view?.phase,
          lastProgressAt: view?.lastProgressAt,
          deadlineAt: view?.deadlineAt,
          terminalRequest: view?.terminalRequest,
          cardId: view?.cardId,
          sessionId: view?.sessionId,
          executionId: view?.executionId,
        } : null,
        pending: this.lanes[lane].pending.map(j => ({
          entryId: j.entry.id,
          runId: j.reservation?.runId,
          manual: j.manual ?? false,
          priority: j.entry.priority ?? "medium",
        })),
      };
    });
  }

  /** #1517: live stale-run ownership port — delegates to the coordinator. */
  owns(runId: string): boolean {
    return this.coordinator.owns(runId);
  }

  /** #1517: live stale-run cancellation — delegates to the coordinator. */
  cancel(runId: string, reason: string): "requested" | "not_owned" {
    return this.coordinator.cancel(runId, reason);
  }

  enqueue(entry: ScheduledTask, manual?: boolean, reservation?: ActiveTaskRun): string | null {
    const inFlight = this.findOccurrence(entry.id);
    // #1517: a supplied reservation rejected before queue ownership transfers
    // must never remain active_run — terminalize it exactly once.
    if (inFlight?.where === "current") {
      if (reservation) this.rejectReservation(entry, reservation, "duplicate-current");
      return `Already running: "${getEntryMessage(entry).slice(0, 60)}"`;
    }
    if (inFlight?.where === "pending") {
      if (reservation) this.rejectReservation(entry, reservation, "duplicate-queued");
      return `Already queued: "${getEntryMessage(entry).slice(0, 60)}"`;
    }

    // #1517: manual callers acquire the reservation at admission so every
    // executable queued/current job owns an exact run ID before transfer.
    // A scheduled caller's supplied reservation is authoritative and is never
    // replaced or re-allocated by executor branches.
    const owned = reservation ?? this.reserveForEntry(entry, manual);
    if (!owned) {
      return `Cannot run: "${getEntryMessage(entry).slice(0, 60)}" — active run in progress`;
    }

    // #1539: lane selection comes from the durable trigger — manual → manual;
    // schedule/retry → scheduled. Priority ordering stays within each lane.
    const lane: RunLane = owned.trigger === "manual" ? "manual" : "scheduled";
    const laneState = this.lanes[lane];
    const rank = PRIO_RANK[entry.priority ?? "medium"] ?? 1;
    let i = 0;
    try {
      while (i < laneState.pending.length) {
        const qRank = PRIO_RANK[laneState.pending[i]!.entry.priority ?? "medium"] ?? 1;
        if (rank < qRank) break;
        i++;
      }
      laneState.pending.splice(i, 0, { entry, manual, reservation: owned });
    } catch (err) {
      logAndSwallow(TAG, "enqueue insert", err);
      this.rejectReservation(entry, owned, "queue-insertion-failed");
      return "Queue error: task could not be admitted";
    }
    logInfo(TAG, `Enqueued "${entry.id}" (${entry.kind}, ${entry.priority ?? "medium"}${manual ? ", manual" : ""}, ${lane} lane) — ${laneState.pending.length} pending`);
    logTaskDebug("task_queue_state", { task: entry.id, run: owned.runId }, `pending=${laneState.pending.length} manual=${manual === true} lane=${lane}`);
    persistState(this.lanes);

    this.processLane(lane);
    return null;
  }

  private findOccurrence(entryId: string): { where: "current" | "pending" } | null {
    for (const lane of LANES) {
      if (this.lanes[lane].current?.entryId === entryId) return { where: "current" };
      if (this.lanes[lane].pending.some(j => j.entry.id === entryId)) return { where: "pending" };
    }
    return null;
  }

  /**
   * #1517: a reservation that never gained queue ownership is terminalized
   * with a bounded queue-admission detail under its own run ID. The
   * interruption/cancelled policy clears without retry or failure counting,
   * so the occurrence ends cleanly and future runs are not blocked.
   */
  private rejectReservation(entry: ScheduledTask, run: ActiveTaskRun, detail: string): void {
    settleRunOnce({
      entry, run, outcome: "cancelled",
      diagnostic: makeTaskFailure("interruption", "cancelled", "queued",
        `queue admission rejected: ${detail}`, "none"),
      detail: `queue_admission_rejected: ${detail}`,
    });
    logWarn(TAG, `Reservation for "${entry.id}" run=${run.runId} rejected at queue admission (${detail}) — settled as cancelled`);
  }

  /** #1539: dequeue, revalidate, record current, and start without awaiting. */
  private processLane(lane: RunLane): void {
    const laneState = this.lanes[lane];
    if (laneState.current || laneState.pending.length === 0) return;
    const job = laneState.pending.shift()!;
    const { entry, manual, reservation } = job;

    // #1517: a queued job may outlive its reservation (live reconciliation
    // settles expired unowned runs). Never execute side effects for a run
    // that no longer owns the active reservation.
    if (reservation) {
      const state = readState(entry.id);
      if (!state?.activeRun || state.activeRun.runId !== reservation.runId) {
        logWarn(TAG, `Job "${entry.id}" run=${reservation.runId} no longer owns the active reservation — skipping execution`);
        this.processLane(lane);
        return;
      }
    }
    const kind = isSystemEntry(entry) ? "system" : entry.kind === "script" ? "script" : entry.kind === "agent" ? "agent" : null;
    if (kind === null || isReminder(entry)) {
      // Reminders are settled immediately by checkCron(); a stray queued copy
      // must not strand its reservation.
      if (reservation) {
        settleRunOnce({ entry, run: reservation, outcome: "success", detail: "reminder already delivered" });
      }
      logInfo(TAG, `Reminder "${entry.id}" already delivered — skipping`);
      this.processLane(lane);
      return;
    }
    if (!reservation) {
      logWarn(TAG, `Task "${entry.id}" reached execution without a reservation — skipping`);
      this.processLane(lane);
      return;
    }

    laneState.current = {
      entryId: entry.id,
      message: getEntryMessage(entry).slice(0, 80),
      pid: 0,
      startedAt: Date.now(),
      type: kind,
      manual,
      runId: reservation.runId,
      lane,
    };
    persistState(this.lanes);

    // #1539: a start exception settles the owned reservation once and
    // continues with the next job — the lane must never wedge on a throw.
    let started: "started" | "stale";
    try {
      started = this.coordinator.start(entry, reservation, lane);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `Start failed for "${entry.id}" run=${reservation.runId}: ${msg}`);
      settleRunOnce({
        entry, run: reservation, outcome: "failed",
        diagnostic: makeTaskFailure("execution", "model_error", "executing", msg.slice(0, 500), "none"),
        detail: msg.slice(0, 500),
        factAt: Date.now(),
        onFailure: this.coordinator.failureCallback,
      });
      laneState.current = null;
      persistState(this.lanes);
      this.processLane(lane);
      return;
    }
    if (started === "stale") {
      logWarn(TAG, `Job "${entry.id}" run=${reservation.runId} lost its reservation before start — lane released`);
      laneState.current = null;
      persistState(this.lanes);
      this.processLane(lane);
      return;
    }
    logTaskDebug("run_admitted", { task: entry.id, run: reservation.runId }, `lane=${lane} kind=${kind}`);
  }

  /** #1539: lane release on the durable terminal event — run ID must match. */
  private onRunTerminal(runId: string): void {
    for (const lane of LANES) {
      const laneState = this.lanes[lane];
      if (laneState.current && laneState.current.runId === runId) {
        laneState.current = null;
        persistState(this.lanes);
        logTaskDebug("lane_released", { run: runId }, `lane=${lane}`);
        this.processLane(lane);
        return;
      }
    }
    // Terminal for a run this queue no longer tracks (recovery repair of an
    // already-cleared lane, duplicate/late callback): pump defensively.
    for (const lane of LANES) this.processLane(lane);
  }

  private reserveForEntry(entry: ScheduledTask, manual?: boolean): ActiveTaskRun | null {
    const now = Date.now();
    const res = reserveRun(entry.id, {
      runId: createRunId(entry.id),
      groupId: `${entry.id}:group:${now}`,
      attempt: manual ? 1 : (readState(entry.id)?.retrying ? 2 : 1),
      trigger: manual ? "manual" : "schedule",
      occurrenceAt: now,
      deadlineAt: now + runCeilingMs(),
    });
    if (res.ok) return res.run;
    logWarn(TAG, `Cannot run "${entry.id}": active run in progress ${res.active.runId}`);
    return null;
  }
}

const PRIO_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
