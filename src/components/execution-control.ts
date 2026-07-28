import { logDebug } from "./logger.js";
import type { CancelReason } from "./swarm-executor-types.js";

export type TerminalOutcome = "completed" | "failed" | "cancelled" | "timed_out";

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
  requestCancel(reason: CancelReason): Promise<"cancelled" | "already_terminal" | "not_found">;
  /** #1506: Non-blocking cancellation signal — sets state and fires provider interrupt
   *  without awaiting acknowledgement or cleanup. Use for deadlines and forced terminates. */
  signalCancel(reason: CancelReason): "cancelled" | "already_terminal" | "not_found";
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

  async requestCancel(reason: CancelReason): Promise<"cancelled" | "already_terminal" | "not_found"> {
    if (this._terminal) return "already_terminal";
    this._cancelled = true;
    this._cancelReason = reason;
    if (this._cancelFn) {
      await Promise.resolve(this._cancelFn(reason)).catch(() => {});
    }
    return "cancelled";
  }

  signalCancel(reason: CancelReason): "cancelled" | "already_terminal" | "not_found" {
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

// ── Registry (keyed by executionRef) ──────────────────────────────────────────

const _controls = new Map<string, ExecutionControlImpl>();

export function registerControl(executionRef: string, opts?: { cardId?: number; attemptId?: string; generation?: number }): ExecutionControl {
  const existing = _controls.get(executionRef);
  if (existing) return existing;
  const ctrl = new ExecutionControlImpl(executionRef, opts);
  _controls.set(executionRef, ctrl);
  logDebug(TAG, `Registered control ref=${executionRef}`);
  return ctrl;
}

export function getControl(executionRef: string): ExecutionControl | undefined {
  return _controls.get(executionRef);
}

export function removeControl(executionRef: string): void {
  _controls.delete(executionRef);
  logDebug(TAG, `Removed control ref=${executionRef}`);
}

/** @deprecated Use registerControl/removeControl with the executionRef. */
export function registerWorkerControl(attemptId: string, generation: number, cardId: number): ExecutionControl {
  return registerControl(`${attemptId}:${generation}`, { attemptId, generation, cardId });
}

/** @deprecated Use removeControl. */
export function removeControlByAttempt(attemptId: string): void {
  for (const [k, ctrl] of _controls) {
    if (ctrl.attemptId === attemptId) {
      _controls.delete(k);
      logDebug(TAG, `Removed control attempt=${attemptId}`);
    }
  }
}

export function hasLiveControl(executionRef: string): boolean {
  const ctrl = _controls.get(executionRef);
  if (!ctrl) return false;
  return !ctrl.terminal;
}
