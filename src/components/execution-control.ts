/**
 * execution-control.ts — #1366/#1506/#1533 execution control handles and the
 * #1540 closure-backed execution supervisor.
 *
 * The supervisor owns all live in-process execution state: control handles,
 * per-session generation binding, occupancy (running-card sets per session
 * type), Healer cooldown, and the legacy unsupervised Kanban drain. There is
 * exactly one supervisor instance in production composition (Spin's), shared
 * with the scheduled-run coordinator and the worker adapter. Durable
 * scheduled-run terminal authority stays with #1539's coordinator/settler.
 */

import { logDebug, logWarn } from "./logger.js";
import { kanbanQueuedDispatchOrder, kanbanFail, isUnblocked, type KanbanCard } from "./tasks/kanban-board.js";
import { isValidSessionType } from "./spin-profiles.js";
import { WorkerSupervisionStore } from "./worker-supervision-store.js";
import { ProjectReviewStore } from "./project-acceptance/project-review-store.js";
import type { CancelReason } from "./swarm-executor-types.js";
import type { SessionType } from "./spin-types.js";
import type { SpinRequest } from "./spin-types.js";

export type TerminalOutcome = "completed" | "failed" | "cancelled" | "timed_out";

export type ControlResult = "cancelled" | "already_terminal" | "not_found";

export interface ExecutionControl {
  readonly executionRef: string;
  readonly cardId?: number;
  /** #1366: Worker attempt ID (set for supervised cards only). */
  readonly attemptId?: string;
  /** #1366: Worker generation (set for supervised cards only). */
  readonly generation?: number;
  readonly cancelled: boolean;
  readonly cancelReason?: CancelReason;
  readonly terminal: boolean;
  readonly terminalOutcome?: TerminalOutcome;

  bind(cancel: (reason: CancelReason) => Promise<void> | void): boolean;
  /** Attach the card once Spin has allocated it, before execution can settle. */
  setCardId(cardId: number): void;
  requestCancel(reason: CancelReason): Promise<ControlResult>;
  /** #1506: Non-blocking cancellation signal — sets state and fires provider interrupt
   *  without awaiting acknowledgement or cleanup. Use for deadlines and forced terminates. */
  signalCancel(reason: CancelReason): ControlResult;
  markTerminal(outcome: TerminalOutcome): boolean;
}

export type WorkerExecutionControl = ExecutionControl;
export type WorkerTerminalOutcome = TerminalOutcome;

const TAG = "exec-control";

class ExecutionControlImpl implements ExecutionControl {
  readonly executionRef: string;
  readonly attemptId?: string;
  readonly generation?: number;
  private _cardId?: number;
  private _cancelled = false;
  private _cancelReason?: CancelReason;
  private _cancelFn: ((reason: CancelReason) => Promise<void> | void) | null = null;
  private _bound = false;
  private _terminal = false;
  private _terminalOutcome?: TerminalOutcome;

  constructor(executionRef: string, opts?: { cardId?: number; attemptId?: string; generation?: number }) {
    this.executionRef = executionRef;
    this._cardId = opts?.cardId;
    this.attemptId = opts?.attemptId;
    this.generation = opts?.generation;
  }

  get cancelled(): boolean { return this._cancelled; }
  get cancelReason(): CancelReason | undefined { return this._cancelReason; }
  get cardId(): number | undefined { return this._cardId; }
  get terminal(): boolean { return this._terminal; }
  get terminalOutcome(): TerminalOutcome | undefined { return this._terminalOutcome; }

  setCardId(cardId: number): void {
    if (this._cardId === undefined) this._cardId = cardId;
  }

  bind(cancel: (reason: CancelReason) => Promise<void> | void): boolean {
    if (this._bound) return false;
    this._bound = true;
    this._cancelFn = cancel;
    if (this._cancelled && this._cancelReason) {
      const reason = this._cancelReason;
      queueMicrotask(() => {
        void Promise.resolve(this._cancelFn!(reason)).catch(() => {});
      });
    }
    return true;
  }

  async requestCancel(reason: CancelReason): Promise<ControlResult> {
    if (this._terminal) return "already_terminal";
    this._cancelled = true;
    this._cancelReason = reason;
    if (this._cancelFn) {
      await Promise.resolve(this._cancelFn(reason)).catch(() => {});
    }
    return "cancelled";
  }

  signalCancel(reason: CancelReason): ControlResult {
    if (this._terminal) return "already_terminal";
    this._cancelled = true;
    this._cancelReason = reason;
    if (this._cancelFn) {
      queueMicrotask(() => { void Promise.resolve(this._cancelFn!(reason)).catch(() => {}); });
    }
    return "cancelled";
  }

  markTerminal(outcome: TerminalOutcome): boolean {
    if (this._terminal) return false;
    this._terminal = true;
    this._terminalOutcome = outcome;
    return true;
  }
}

/**
 * Immutable execution identity registered before dispatch, when no session
 * exists yet. `type` is carried for future per-type admission on open; the
 * current admission path stays with Spin's `canAdmit`/`admit`.
 */
export interface ExecutionIdentity {
  executionRef: string;
  generation?: number;
  type: SessionType;
  cardId?: number;
  attemptId?: string;
}

/**
 * Closure-backed execution supervisor (#1540). The concrete control registry,
 * session bindings, occupancy sets, and Healer cooldown live only inside the
 * factory. Scheduled/worker callers open a handle before Spin allocates a
 * session; Spin binds it to the exact session it returns before transport
 * execution starts.
 */
export interface ExecutionSupervisor {
  /** Register a control handle for an execution ref (idempotent per ref). */
  open(identity: ExecutionIdentity): ExecutionControl;
  /**
   * Bind a handle to the session Spin allocated for it. Rejects a second
   * active generation for the same session unless the old handle is already
   * terminal — never a silent overwrite (see #1540 audit).
   */
  bindSession(executionRef: string, sessionId: string): boolean;
  get(executionRef: string): ExecutionControl | undefined;
  getForSession(sessionId: string): ExecutionControl | undefined;
  cancel(executionRef: string, reason: CancelReason): Promise<ControlResult>;
  signalCancel(executionRef: string, reason: CancelReason): ControlResult;
  /** Mark a control terminal; releases occupancy for its card once. */
  close(executionRef: string, outcome: TerminalOutcome): boolean;
  /** Drop a control handle and its session binding from the registry. */
  remove(executionRef: string): boolean;
  /** #987/#1274: per-type admission gate (capacity + Healer cooldown). */
  canAdmit(type: SessionType, cardId?: number): boolean;
  /** Admit a card: gate check + occupancy mark in one step. */
  admit(type: SessionType, cardId: number): boolean;
  /** Release occupancy for a card; records Healer completion time. */
  release(type: SessionType, cardId: number): void;
  /** #1439: full set of card IDs Spin considers running, across all types. */
  runningCardIds(): readonly number[];
  runningCount(type: SessionType): number;
  healerCooldownEndAt(): number;
  healerInCooldown(): boolean;
  /**
   * Legacy unsupervised Kanban drain — the only dispatcher for parentless
   * cards in retry backoff (the Reconciler pump skips them and the dispatch
   * query filters future `next_retry_at`). Wired as a consumer of #1539's
   * `kanban-retry` due source alongside Reconciler dispatch.
   */
  drainLegacyQueued(dispatch: (request: SpinRequest) => void): void;
  clear(): void;
}

export interface ExecutionSupervisorOptions {
  maxConcurrent: Partial<Record<SessionType, number>>;
  now?: () => number;
  onOccupancyChanged?: (cardIds: readonly number[]) => void;
}

/**
 * #1540: typed facade failure for a rejected execution bind. Bounded,
 * operator-visible message; never an unhandled throw, a silently dropped
 * turn, or execution of an unbound generation.
 */
export class SpinBindRejectionError extends Error {
  readonly code = "execution_bind_rejected" as const;

  constructor(executionRef: string, sessionId: string, existingRef?: string) {
    super(`Spin: session ${sessionId} already has an active execution (${existingRef ?? "unknown"}) — bind of ${executionRef} rejected`);
    this.name = "SpinBindRejectionError";
  }
}

/** #1364: Returns true if a card has an active supervision contract. */
function cardHasSupervision(cardId: number): boolean {
  try {
    const store = new WorkerSupervisionStore();
    return store.contractExists(cardId) && store.hasLiveClaim(cardId);
  } catch { return false; }
}

/**
 * #1618: source-neutral supervised-root identity — any root card (type O, no
 * parent) with a non-terminal `project_supervision` row. Supervised roots are
 * owned by the Orc/Reconciler driver and must never be dispatched by the
 * legacy Spin drain, regardless of how they were admitted.
 */
function isSupervisedRootIdentity(card: KanbanCard): boolean {
  if (card.type !== "O" || card.parent_id !== null) return false;
  try {
    return new ProjectReviewStore().hasActiveProjectSupervision(card.id);
  } catch {
    return false;
  }
}

export function createExecutionSupervisor(options: ExecutionSupervisorOptions): ExecutionSupervisor {
  const controls = new Map<string, ExecutionControlImpl>();
  const sessionBindings = new Map<string, string>();   // sessionId → executionRef
  const refSessions = new Map<string, string>();       // executionRef → sessionId
  const running = new Map<SessionType, Set<number>>();
  const maxConcurrent = options.maxConcurrent;
  const now = options.now ?? (() => Date.now());
  const onOccupancyChanged = options.onOccupancyChanged;

  let lastHealerDoneAt = 0;

  function activeCardIds(): number[] {
    const ids: number[] = [];
    for (const set of running.values()) {
      for (const id of set) ids.push(id);
    }
    return ids;
  }

  function publishActiveCardIds(): void {
    if (onOccupancyChanged) onOccupancyChanged(activeCardIds());
    import("./runtime-health-snapshot.js").then(({ updateActiveCardIds }) => {
      updateActiveCardIds(activeCardIds());
    }).catch(() => { /* best effort — snapshot is a health surface, not authoritative */ });
  }

  function canAdmit(type: SessionType, _cardId?: number): boolean {
    const max = maxConcurrent[type] ?? 5;
    if ((running.get(type)?.size ?? 0) >= max) return false;
    // #987: 2-min cooldown after H session ends
    if (type === "H" && now() - lastHealerDoneAt < 120_000) return false;
    return true;
  }

  function admit(type: SessionType, cardId: number): boolean {
    if (!canAdmit(type, cardId)) return false;
    if (!running.has(type)) running.set(type, new Set());
    running.get(type)!.add(cardId);
    publishActiveCardIds();
    return true;
  }

  function release(type: SessionType, cardId: number): void {
    running.get(type)?.delete(cardId);
    if (type === "H") lastHealerDoneAt = now();
    publishActiveCardIds();
  }

  function drainLegacyQueued(dispatch: (request: SpinRequest) => void): void {
    const queued = kanbanQueuedDispatchOrder();
    for (const card of queued) {
      // #1364/#1546/#1618: Supervised cards (Worker children or any actively
      // supervised project root — scheduled, peer, CLI) go through the
      // Reconciler/Orc coordinator — skip them here
      if (cardHasSupervision(card.id) || isSupervisedRootIdentity(card)) continue;
      // #1638/#1648: Pi cards are Reconciler-owned — never dispatch or fail
      // them from the Spin legacy drain. Standalone Pi cards start only via
      // the Reconciler Pi lane after shared admission.
      if (card.type === "pi") continue;
      // #677: respect DAG dependencies
      if (!isUnblocked(card)) continue;
      // #1327: validate card.type is a real SessionType BEFORE dispatching.
      // Without this, an unknown type (e.g. ticket category "bug") reaches
      // spin() and crashes the bridge on profile.agent access. Fail the card
      // with a clear note instead — Layer A in spin() is the second line of
      // defense if this ever regresses.
      const type = card.type as string;
      if (!isValidSessionType(type)) {
        const note = `invalid type for Spin dispatch: "${type}" is not a SessionType (#1327)`;
        logWarn(TAG, `drainQueued: card ${card.id} has invalid type "${type}" — failing (Layer B)`);
        kanbanFail(card.id, note);
        continue;
      }
      if (canAdmit(type as SessionType, card.id)) {
        const goal = (card as { goal?: string }).goal || card.title;
        dispatch({ type: type as SessionType, goal, source: (card.source as SpinRequest["source"]) ?? "task", cardId: card.id, settlementOwner: "spin" });
      }
    }
  }

  return {
    open(identity) {
      const existing = controls.get(identity.executionRef);
      if (existing) return existing;
      const ctrl = new ExecutionControlImpl(identity.executionRef, {
        cardId: identity.cardId,
        attemptId: identity.attemptId,
        generation: identity.generation,
      });
      controls.set(identity.executionRef, ctrl);
      logDebug(TAG, `Registered control ref=${identity.executionRef}`);
      return ctrl;
    },

    bindSession(executionRef, sessionId) {
      const existingRef = sessionBindings.get(sessionId);
      if (existingRef !== undefined && existingRef !== executionRef) {
        const existing = controls.get(existingRef);
        if (existing && !existing.terminal) {
          logWarn(TAG, `Bind rejected: session ${sessionId} already bound to active control ref=${existingRef} (tried ${executionRef})`);
          return false;
        }
        refSessions.delete(existingRef);
      }
      sessionBindings.set(sessionId, executionRef);
      refSessions.set(executionRef, sessionId);
      return true;
    },

    get(executionRef) {
      return controls.get(executionRef);
    },

    getForSession(sessionId) {
      const ref = sessionBindings.get(sessionId);
      if (ref === undefined) return undefined;
      return controls.get(ref);
    },

    async cancel(executionRef, reason) {
      const ctrl = controls.get(executionRef);
      if (!ctrl) return "not_found";
      return await ctrl.requestCancel(reason);
    },

    signalCancel(executionRef, reason) {
      const ctrl = controls.get(executionRef);
      if (!ctrl) return "not_found";
      return ctrl.signalCancel(reason);
    },

    close(executionRef, outcome) {
      const ctrl = controls.get(executionRef);
      if (!ctrl) return false;
      // #1540: cleanup of a stale generation must never mutate its successor —
      // only a still-bound control may change occupancy. An unbound control
      // (binding dropped by remove()) resolves to a no-op.
      if (refSessions.get(executionRef) === undefined) return false;
      const transitioned = ctrl.markTerminal(outcome);
      if (transitioned && ctrl.cardId !== undefined) {
        for (const [type, set] of running) {
          if (set.delete(ctrl.cardId)) {
            if (type === "H") lastHealerDoneAt = now();
            publishActiveCardIds();
            break;
          }
        }
      }
      return transitioned;
    },

    remove(executionRef) {
      const had = controls.delete(executionRef);
      const sessionId = refSessions.get(executionRef);
      if (sessionId !== undefined) {
        refSessions.delete(executionRef);
        if (sessionBindings.get(sessionId) === executionRef) sessionBindings.delete(sessionId);
      }
      if (had) logDebug(TAG, `Removed control ref=${executionRef}`);
      return had;
    },

    canAdmit(type, cardId) {
      return canAdmit(type, cardId);
    },

    admit(type, cardId) {
      return admit(type, cardId);
    },

    release(type, cardId) {
      release(type, cardId);
    },

    runningCardIds() {
      return activeCardIds();
    },

    runningCount(type) {
      return running.get(type)?.size ?? 0;
    },

    healerCooldownEndAt() {
      return lastHealerDoneAt + 120_000;
    },

    healerInCooldown() {
      return now() - lastHealerDoneAt < 120_000;
    },

    drainLegacyQueued(dispatch) {
      drainLegacyQueued(dispatch);
    },

    clear() {
      controls.clear();
      sessionBindings.clear();
      refSessions.clear();
      running.clear();
      lastHealerDoneAt = 0;
    },
  };
}
